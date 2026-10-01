// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/run-config.ts — the pure run/debug configuration model (plan file 13 ·
 * JetBrains Run Configurations · VS Code launch.json parity).
 *
 * Normalizes VS Code `launch.json` (`configurations` + `compounds`) into a flat, typed
 * `RunConfig[]`, and resolves a compound configuration into its ordered member launch
 * sequence (cycle-guarded). This is the model DebugPanel's picker + the future Run
 * toolbar consume; keeping it PURE (no react/monaco/engine) makes it node:test-able and
 * shareable with the prometheus CLI `/run` surface. The DAP request mapping stays in
 * DebugPanel (it is transport-specific).
 */

/** Strip //-line + block comments (JSONC), respecting strings, then drop trailing commas. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  let esc = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
    } else if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else if (c === ",") {
      // drop a trailing comma (`,` → optional ws → `}`/`]`) HERE, inside the string-aware scan,
      // so a literal `,}` / `,]` INSIDE a string value (a glob, a message) is never corrupted.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++; // trailing comma — skip it
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Parse JSONC → value, or null on any error (fail-soft — the caller renders nothing). */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
}

/** A normalized run/debug configuration (one launch.json entry OR a compound). */
export interface RunConfig {
  name: string;
  /** launch type (python/debugpy/node/…) or "compound" for a multi-member config. */
  type: string;
  request: "launch" | "attach";
  program?: string;
  module?: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
  /** a tasks.json task to run before launch (opaque here — tasks live in plan 22/13). */
  preLaunchTask?: string;
  /** member config names, when `type === "compound"`. */
  compound?: string[];
  /** the original untouched object (DebugPanel maps schema-allowed fields off this). */
  raw: Record<string, unknown>;
  /** fields NO consumer maps (dropped raw keys, unresolvable `${command:…}` vars,
   *  unknown JetBrains macros/types) — surfaced in the UI, never silently lost (APP-081). */
  unsupported?: string[];
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Every raw key SOME consumer maps: the RunConfig fields above plus the
 *  schema-allowed fields DebugPanel's dapLaunch mapper + buildRunInvocation
 *  read straight off `raw` (python/console/connect/runtimeArgs). */
const CONSUMED_RAW_KEYS: readonly string[] = [
  "name",
  "type",
  "request",
  "program",
  "module",
  "cwd",
  "args",
  "env",
  "preLaunchTask",
  "python",
  "console",
  "connect",
  "runtimeArgs",
];

/** `${command:…}` / `${input:…}` need VS Code UI to resolve — they can never be
 *  substituted headlessly, so they're flagged, not executed (APP-081). */
const UNRESOLVABLE_VAR = /\$\{(?:command|input):[^}]*\}/g;

function coerceConfig(o: Record<string, unknown>): RunConfig | null {
  const name = asStr(o.name);
  if (!name) return null;
  const cfg: RunConfig = {
    name,
    type: asStr(o.type) ?? "python",
    request: o.request === "attach" ? "attach" : "launch",
    raw: o,
  };
  const program = asStr(o.program);
  if (program) cfg.program = program;
  const mod = asStr(o.module);
  if (mod) cfg.module = mod;
  const cwd = asStr(o.cwd);
  if (cwd) cfg.cwd = cwd;
  if (Array.isArray(o.args)) cfg.args = o.args.filter((a): a is string => typeof a === "string");
  const pre = asStr(o.preLaunchTask);
  if (pre) cfg.preLaunchTask = pre;
  if (o.env && typeof o.env === "object" && !Array.isArray(o.env)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v;
    }
    cfg.env = env;
  }
  // APP-081: collect what the import DROPS — raw keys no consumer maps, plus
  // launch-variable references no headless substitution can ever resolve.
  const unsupported: string[] = [];
  for (const k of Object.keys(o)) {
    if (!CONSUMED_RAW_KEYS.includes(k)) unsupported.push(k);
  }
  const mappedStrings = [
    cfg.program,
    cfg.module,
    cfg.cwd,
    ...(cfg.args ?? []),
    ...Object.values(cfg.env ?? {}),
  ];
  for (const s of mappedStrings) {
    if (typeof s !== "string") continue;
    for (const m of s.match(UNRESOLVABLE_VAR) ?? []) unsupported.push(`var:${m}`);
  }
  if (unsupported.length > 0) cfg.unsupported = [...new Set(unsupported)];
  return cfg;
}

/**
 * Parse a launch.json blob → a flat RunConfig[]. Reads the VS Code `configurations`
 * array, plus `compounds` (each becomes a `type:"compound"` entry carrying its member
 * names). A bare configuration array (no wrapper object) is also accepted. Malformed
 * entries are dropped; a completely unparseable blob yields [].
 */
export function parseLaunchJson(text: string): RunConfig[] {
  const doc = parseJsonc(text);
  const out: RunConfig[] = [];
  const configsRaw = Array.isArray(doc)
    ? doc
    : doc &&
        typeof doc === "object" &&
        Array.isArray((doc as Record<string, unknown>).configurations)
      ? ((doc as Record<string, unknown>).configurations as unknown[])
      : [];
  for (const c of configsRaw) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cfg = coerceConfig(c as Record<string, unknown>);
      if (cfg) out.push(cfg);
    }
  }
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    const compounds = (doc as Record<string, unknown>).compounds;
    if (Array.isArray(compounds)) {
      for (const c of compounds) {
        if (!c || typeof c !== "object") continue;
        const o = c as Record<string, unknown>;
        const name = asStr(o.name);
        if (!name) continue;
        const members = Array.isArray(o.configurations)
          ? (o.configurations as unknown[]).filter((m): m is string => typeof m === "string")
          : [];
        out.push({ name, type: "compound", request: "launch", compound: members, raw: o });
      }
    }
  }
  return out;
}

/**
 * Resolve the ordered launch sequence for a config `name`: a compound expands to its
 * members (recursively, de-duplicated, cycle-guarded); a plain config resolves to
 * itself. Unknown names / missing members are skipped. Returns [] if `name` is unknown.
 */
export function resolveRunOrder(configs: readonly RunConfig[], name: string): RunConfig[] {
  const byName = new Map(configs.map((c) => [c.name, c]));
  const seen = new Set<string>();
  const out: RunConfig[] = [];
  const walk = (n: string): void => {
    if (seen.has(n)) return; // cycle / already included
    const cfg = byName.get(n);
    if (!cfg) return;
    seen.add(n);
    if (cfg.type === "compound" && cfg.compound) {
      for (const m of cfg.compound) walk(m);
    } else {
      out.push(cfg);
    }
  };
  if (!byName.has(name)) return [];
  walk(name);
  return out;
}

/* ── JetBrains .idea/runConfigurations import (APP-081) — PURE, regex XML ──────
 * JetBrains run-config files are small flat `<option name value>` XML; targeted
 * regex extraction with entity-unescape is the accepted approach here (no XML
 * parser dependency exists in this repo, and none may be added). */

/** Unescape XML entities: numeric refs + named non-amp FIRST, `&amp;` LAST — so
 *  `&amp;lt;` yields the literal `&lt;`, never `<`. Invalid codepoints stay literal. */
function unescapeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (whole, d: string) => {
      const cp = Number(d);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (whole, h: string) => {
      const cp = Number.parseInt(h, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The `key="value"` attribute pairs of ONE tag open (any order, values unescaped). */
function xmlAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w.:-]+)="([^"]*)"/g)) {
    const k = m[1];
    const v = m[2];
    if (k !== undefined && v !== undefined) out[k] = unescapeXml(v);
  }
  return out;
}

/** `$PROJECT_DIR$` (the `.idea` parent = workspace root) → `${workspaceFolder}`,
 *  resolved at launch by the SAME substitution site launch.json values use. Any
 *  OTHER `$MACRO$` stays literal and is reported so the user sees it unresolved. */
function substituteJetBrainsMacros(value: string, unsupported: string[]): string {
  const out = value.replaceAll("$PROJECT_DIR$", "${workspaceFolder}");
  for (const m of out.matchAll(/\$[A-Z_][A-Z0-9_]*\$/g)) unsupported.push(`macro:${m[0]}`);
  return out;
}

/**
 * Parse ONE JetBrains `.idea/runConfigurations/*.xml` blob → a RunConfig, or
 * null when malformed (no `<configuration>` / no name) or a `default="true"`
 * type template. `PythonConfigurationType` → type "python" (SCRIPT_NAME +
 * MODULE_MODE decide program-vs-module), `NodeJSConfigurationType` → "node"
 * (attribute-carried fields); any other type imports name-only with
 * `unsupported:["type:<raw>"]`. `raw` mirrors the launch.json shape so the
 * native store round-trips it through serializeLaunchJson → parseLaunchJson
 * → DebugPanel's dapLaunch mapper unchanged.
 */
export function parseJetBrainsRunConfig(xml: string): RunConfig | null {
  const confTag = /<configuration\b[^>]*>/.exec(xml)?.[0];
  if (!confTag) return null;
  const attrs = xmlAttrs(confTag);
  const name = attrs.name;
  if (name === undefined || name === "") return null;
  if (attrs.default === "true") return null; // a type TEMPLATE, not a user config
  const rawType = attrs.type ?? "";
  const unsupported: string[] = [];
  const sub = (v: string): string => substituteJetBrainsMacros(v, unsupported);

  // `<option name="K" value="V"/>` pairs (the python-family layout)
  const options: Record<string, string> = {};
  for (const m of xml.matchAll(/<option\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?>/g)) {
    const k = m[1];
    const v = m[2];
    if (k !== undefined && v !== undefined) options[k] = unescapeXml(v);
  }
  // `<envs><env name="K" value="V"/></envs>` (shared by python + node layouts)
  const env: Record<string, string> = {};
  const envsBlock = /<envs>([\s\S]*?)<\/envs>/.exec(xml)?.[1] ?? "";
  for (const m of envsBlock.matchAll(/<env\s+name="([^"]+)"\s+value="([^"]*)"\s*\/?>/g)) {
    const k = m[1];
    const v = m[2];
    if (k !== undefined && v !== undefined) env[k] = sub(unescapeXml(v));
  }

  const raw: Record<string, unknown> = { name, request: "launch" };
  const cfg: RunConfig = { name, type: "python", request: "launch", raw };
  if (rawType === "PythonConfigurationType") {
    const script = options.SCRIPT_NAME;
    if (script) {
      // MODULE_MODE=true runs `-m <SCRIPT_NAME>`; otherwise SCRIPT_NAME is the file.
      const v = sub(script);
      if (options.MODULE_MODE === "true") cfg.module = v;
      else cfg.program = v;
    }
    if (options.PARAMETERS) {
      const args = parseRunAnything(sub(options.PARAMETERS));
      if (args.length > 0) cfg.args = args;
    }
    if (options.WORKING_DIRECTORY) cfg.cwd = sub(options.WORKING_DIRECTORY);
    if (options.SDK_HOME) raw.python = sub(options.SDK_HOME); // the configured interpreter
  } else if (rawType === "NodeJSConfigurationType") {
    // the node layout carries its fields as configuration ATTRIBUTES, not options.
    cfg.type = "node";
    const prog = attrs["path-to-js-file"];
    if (prog) cfg.program = sub(prog);
    const wd = attrs["working-dir"];
    if (wd) cfg.cwd = sub(wd);
    const appArgs = attrs["application-parameters"];
    if (appArgs) {
      const args = parseRunAnything(sub(appArgs));
      if (args.length > 0) cfg.args = args;
    }
    const nodeArgs = attrs["node-parameters"];
    if (nodeArgs) {
      const runtimeArgs = parseRunAnything(sub(nodeArgs));
      if (runtimeArgs.length > 0) raw.runtimeArgs = runtimeArgs;
    }
  } else {
    // unknown type: import name-only so nothing is silently lost — the flag says why.
    cfg.type = rawType === "" ? "unknown" : rawType;
    unsupported.push(`type:${rawType === "" ? "(none)" : rawType}`);
  }
  if (Object.keys(env).length > 0) cfg.env = env;
  raw.type = cfg.type;
  if (cfg.program !== undefined) raw.program = cfg.program;
  if (cfg.module !== undefined) raw.module = cfg.module;
  if (cfg.args !== undefined) raw.args = cfg.args;
  if (cfg.cwd !== undefined) raw.cwd = cfg.cwd;
  if (cfg.env !== undefined) raw.env = cfg.env;
  if (unsupported.length > 0) cfg.unsupported = [...new Set(unsupported)];
  return cfg;
}

/** One discovered foreign config, tagged with where it was found (the UI badge). */
export interface ImportCandidate {
  config: RunConfig;
  source: "vscode" | "jetbrains";
}

/**
 * Merge the discovered foreign configs into ONE import list (APP-081). A name
 * already in the NATIVE store is skipped (already imported). On a vscode ↔
 * jetbrains collision vscode keeps the plain name and the JetBrains config is
 * renamed `<name> (.idea)` (numbered if still taken) — both survive, and the
 * source badge stays unambiguous.
 */
export function mergeImportCandidates(
  vscode: readonly RunConfig[],
  jetbrains: readonly RunConfig[],
  existingNames: ReadonlySet<string>,
): ImportCandidate[] {
  const out: ImportCandidate[] = [];
  const taken = new Set(existingNames);
  for (const c of vscode) {
    if (taken.has(c.name)) continue;
    taken.add(c.name);
    out.push({ config: c, source: "vscode" });
  }
  for (const c of jetbrains) {
    if (existingNames.has(c.name)) continue; // already in the native store
    let name = c.name;
    if (taken.has(name)) {
      name = `${c.name} (.idea)`;
      for (let n = 2; taken.has(name); n++) name = `${c.name} (.idea ${n})`;
    }
    taken.add(name);
    out.push({
      config: name === c.name ? c : { ...c, name, raw: { ...c.raw, name } },
      source: "jetbrains",
    });
  }
  return out;
}

/** De-dup a merged config list by name, keep-FIRST (the name is the picker's
 *  identity — a post-import .vscode/.prometheus overlap must not double-list). */
export function dedupeConfigsByName(configs: readonly RunConfig[]): RunConfig[] {
  const seen = new Set<string>();
  const out: RunConfig[] = [];
  for (const c of configs) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}

/* ── Run-Anything tokenizer + run-picker rows (APP-034) — PURE ───────────────── */

/**
 * Tokenize a freeform "Run Anything" line into argv (APP-034). Quote-aware
 * (single AND double) with backslash escaping outside single quotes, and ZERO
 * shell expansion: `$VAR`, `~`, `*`, backticks, `;`, `&&`, `|` all stay literal
 * argv characters. Empty/whitespace-only lines AND an empty first token (`""`)
 * return [] — nothing spawnable.
 */
export function parseRunAnything(line: string): string[] {
  const argv: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  let esc = false;
  for (const ch of line) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      esc = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        argv.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (esc) cur += "\\";
  if (has) argv.push(cur);
  if (argv.length === 0 || argv[0] === "") return []; // an empty program is refused
  return argv;
}

/** One row of the ⌘⇧R run picker: a named config or the always-last freeform line. */
export interface RunPickerRow {
  kind: "config" | "freeform";
  /** config rows: the config name; freeform rows: the raw line. */
  label: string;
  compound: boolean;
  /** freeform rows: the RESOLVED argv (the confirm surface — how quoting split). */
  argv: string[];
  score: number;
  positions: number[];
}

/**
 * Rank the run-picker rows: named configs fuzzy-matched by name (scoreFn is
 * injected so this stays matcher-agnostic and testable), then the freeform row
 * ALWAYS present and ALWAYS last — a typed command line stays dispatchable even
 * when it prefix-collides with a config name.
 */
export function buildRunPickerRows(
  query: string,
  configs: readonly RunConfig[],
  scoreFn: (query: string, text: string) => { score: number; positions: number[] } | null,
): RunPickerRow[] {
  const q = query.trim();
  const rows: RunPickerRow[] = [];
  for (const c of configs) {
    const m = q === "" ? { score: 0, positions: [] } : scoreFn(q, c.name);
    if (m) {
      rows.push({
        kind: "config",
        label: c.name,
        compound: c.type === "compound",
        argv: [],
        score: m.score,
        positions: m.positions,
      });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  rows.push({
    kind: "freeform",
    label: q,
    compound: false,
    argv: parseRunAnything(q),
    score: Number.NEGATIVE_INFINITY,
    positions: [],
  });
  return rows;
}

/** The toolbar's disabled-state truth table (APP-034): a live plain run and a
 *  live DAP session are DIFFERENT things — Stop halts either. */
export function runToolbarState(s: {
  hasConfig: boolean;
  runId: string | null;
  dapSessionId: string | null;
}): { runDisabled: boolean; debugDisabled: boolean; stopDisabled: boolean } {
  return {
    runDisabled: !s.hasConfig || s.runId !== null,
    debugDisabled: !s.hasConfig || s.dapSessionId !== null,
    stopDisabled: s.runId === null && s.dapSessionId === null,
  };
}

/* ── launch.json mutation + serialization (APP-033) — PURE; disk IO in the panel ── */

/** The editable fields the config-editor form owns (everything else rides in raw). */
export interface ConfigFields {
  name: string;
  /** canonical python debug type is "debugpy" (2023 split); node is "node". */
  type: string;
  request: "launch" | "attach";
  program?: string;
  module?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** debugpy's interpreter key is literally "python" (a path). */
  python?: string;
}

const KNOWN_FIELD_KEYS = [
  "name",
  "type",
  "request",
  "program",
  "module",
  "args",
  "cwd",
  "env",
  "python",
] as const;

/** Build the on-disk config object: known keys first (stable diffs), then every
 *  UNKNOWN field of the previous raw (JSONC-authored extras survive an edit).
 *  A known field the edit cleared is dropped, never resurrected from prevRaw. */
export function buildRawConfig(
  fields: ConfigFields,
  prevRaw?: Record<string, unknown>,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    name: fields.name,
    type: fields.type,
    request: fields.request,
  };
  if (fields.program !== undefined) raw.program = fields.program;
  if (fields.module !== undefined) raw.module = fields.module;
  if (fields.args !== undefined && fields.args.length > 0) raw.args = fields.args;
  if (fields.cwd !== undefined) raw.cwd = fields.cwd;
  if (fields.env !== undefined && Object.keys(fields.env).length > 0) raw.env = fields.env;
  if (fields.python !== undefined) raw.python = fields.python;
  for (const [k, v] of Object.entries(prevRaw ?? {})) {
    if (!(KNOWN_FIELD_KEYS as readonly string[]).includes(k)) raw[k] = v;
  }
  return raw;
}

/** `<name> copy`, then `<name> copy 2`, `3`, … (case-sensitive scan). */
function uniquifyName(existing: ReadonlySet<string>, base: string): string {
  let candidate = `${base} copy`;
  for (let n = 2; existing.has(candidate); n++) candidate = `${base} copy ${n}`;
  return candidate;
}

/**
 * Insert or replace a config (APP-033). `prevName` identifies the config being
 * edited (a rename); names are the IDENTITY in compounds/resolveRunOrder, so a
 * rename also rewrites compound member lists — never a silent orphan. Returns
 * an error string for an empty name or a rename colliding with another config.
 */
export function upsertConfig(
  configs: readonly RunConfig[],
  fields: ConfigFields,
  prevName?: string,
): RunConfig[] | string {
  const name = fields.name.trim();
  if (name === "") return "configuration name must not be empty";
  const target = prevName ?? name;
  const collides = configs.some((c) => c.name === name && c.name !== target);
  if (collides) return `a configuration named "${name}" already exists`;
  const prev = configs.find((c) => c.name === target);
  const next = coerceConfig(buildRawConfig({ ...fields, name }, prev?.raw));
  if (!next) return "configuration could not be built";
  const out: RunConfig[] = [];
  let replaced = false;
  for (const c of configs) {
    if (c.name === target) {
      out.push(next);
      replaced = true;
    } else if (c.type === "compound" && c.compound && prevName && prevName !== name) {
      // rename ripple: compound member lists follow the config's new name.
      if (c.compound.includes(prevName)) {
        const members = c.compound.map((m) => (m === prevName ? name : m));
        out.push({ ...c, compound: members, raw: { ...c.raw, configurations: members } });
        continue;
      }
      out.push(c);
    } else {
      out.push(c);
    }
  }
  if (!replaced) out.push(next);
  return out;
}

/** Clone a config under a uniquified `<name> copy` (deep, independent raw). */
export function duplicateConfig(configs: readonly RunConfig[], name: string): RunConfig[] | string {
  const src = configs.find((c) => c.name === name);
  if (!src) return `no configuration named "${name}"`;
  const copyName = uniquifyName(new Set(configs.map((c) => c.name)), name);
  const rawClone = JSON.parse(JSON.stringify(src.raw)) as Record<string, unknown>;
  rawClone.name = copyName;
  if (src.type === "compound") {
    return [
      ...configs,
      { ...src, name: copyName, compound: [...(src.compound ?? [])], raw: rawClone },
    ];
  }
  const clone = coerceConfig(rawClone);
  return clone ? [...configs, clone] : `configuration "${name}" could not be cloned`;
}

/** Remove exactly one config; compound member lists drop the deleted name too. */
export function deleteConfig(configs: readonly RunConfig[], name: string): RunConfig[] {
  const out: RunConfig[] = [];
  for (const c of configs) {
    if (c.name === name) continue;
    if (c.type === "compound" && c.compound?.includes(name)) {
      const members = c.compound.filter((m) => m !== name);
      out.push({ ...c, compound: members, raw: { ...c.raw, configurations: members } });
      continue;
    }
    out.push(c);
  }
  return out;
}

/**
 * Serialize the WHOLE config list back to launch.json text: plain configs into
 * `configurations`, compounds into `compounds`, each from its `raw` (unknown
 * fields round-trip; `${...}` variables stay literal strings). Stable 2-space
 * LF JSON. JSONC comments were lost at parse time — the accepted trade (the
 * panel warns once before the first write).
 */
export function serializeLaunchJson(
  configs: readonly RunConfig[],
  opts: { version?: string } = {},
): string {
  const plain = configs.filter((c) => c.type !== "compound").map((c) => c.raw);
  const compounds = configs.filter((c) => c.type === "compound").map((c) => c.raw);
  const doc: Record<string, unknown> = {
    version: opts.version ?? "0.2.0",
    configurations: plain,
    ...(compounds.length > 0 ? { compounds } : {}),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/* ── plain-Run invocation building (APP-032) — PURE; execution lives in main ── */

/** The context a `${...}` launch.json variable resolves against. */
export interface SubstitutionContext {
  workspaceRoot: string;
  /** the active editor file (for `${file}`/`${fileDirname}`) when known. */
  file?: string;
  /** the env `${env:NAME}` reads (a snapshot — never process.env here, C5). */
  env?: Readonly<Record<string, string>>;
}

/**
 * Substitute the BOUNDED known set of launch.json variables; unknown `${...}`
 * stay literal (never a crash, never a shell eval — the value remains ONE argv
 * token whatever it contains).
 */
export function substituteVars(value: string, ctx: SubstitutionContext): string {
  return value.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    if (name === "workspaceFolder") return ctx.workspaceRoot;
    if (name === "workspaceFolderBasename") {
      const clean = ctx.workspaceRoot.replace(/\/+$/, "");
      return clean.slice(clean.lastIndexOf("/") + 1);
    }
    if (name === "cwd") return ctx.workspaceRoot;
    if (name === "file") return ctx.file ?? whole;
    if (name === "fileDirname") {
      if (!ctx.file) return whole;
      const idx = ctx.file.lastIndexOf("/");
      return idx === -1 ? ctx.file : ctx.file.slice(0, idx);
    }
    if (name.startsWith("env:")) return ctx.env?.[name.slice(4)] ?? "";
    return whole; // unknown variable — left literal
  });
}

/**
 * Env keys that can hijack the loader / resolution — NEVER user-overridable
 * (a value is data; a malicious KEY is a code-exec vector, safe-env invariant).
 *
 * ADVISORY ONLY. The renderer is sandboxed and cannot import `@prometheus/engine-bridge`
 * (C5), so this cannot be `isHijackEnvKey` itself. Enforcement lives in MAIN —
 * `main/ide/run-host.ts` `sanitizeRunEnvKeys`, which calls that predicate — and a renderer
 * that skipped this list entirely would change nothing about what actually reaches a child.
 * This exists so the UI can tell the user which keys will be dropped, before they submit.
 *
 * It is kept in step BY HAND with `safe-env.ts`'s `STRIP_EXACT` + `STRIP_PREFIX`, plus `PATH`
 * (which engine-bridge permits for its own children but a user-supplied run request may not
 * repoint). It was seven names until 2026-10-01 and had fallen ten behind, so the dialog
 * promised keys would survive that main then dropped — harmless to security, actively
 * confusing to the user. If the two ever disagree again, MAIN WINS; fix this list.
 */
export const RUN_ENV_KEY_DENYLIST: readonly string[] = [
  // user-supplied override only — engine-bridge deliberately permits PATH for its own children
  "PATH",
  // dynamic linker preload / search-path hijacks (glibc + musl)
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  // Python import-path / startup-code hijacks
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PYTHONEXECUTABLE",
  "PYTHONUSERBASE",
  "PYTHONBREAKPOINT",
  "PYTHONCASEOK",
  // Node loader hijacks
  "NODE_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  // shell startup-file hooks (defensive even with shell:false)
  "BASH_ENV",
  "ENV",
];

/** Every variable in the macOS dyld family is a loader hijack — matched by PREFIX, because
 *  naming two of them (as this file did) lets DYLD_FRAMEWORK_PATH and the rest through. */
const RUN_ENV_KEY_DENY_PREFIXES: readonly string[] = ["DYLD_"];

/** Does this key match the advisory denylist (exact name or hijack prefix)? */
export function isDeniedRunEnvKey(name: string): boolean {
  const k = name.toUpperCase();
  return RUN_ENV_KEY_DENYLIST.includes(k) || RUN_ENV_KEY_DENY_PREFIXES.some((p) => k.startsWith(p));
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keep only well-formed, non-denylisted env keys; report what was dropped. */
export function sanitizeRunEnv(env: Readonly<Record<string, string>> | undefined): {
  env: Record<string, string>;
  dropped: string[];
} {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!ENV_KEY.test(k) || isDeniedRunEnvKey(k)) {
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  return { env: out, dropped };
}

const MODULE_NAME = /^[\w.]+$/;

/** What the run-host spawns: argv ARRAY only — never a shell string. */
export interface RunInvocation {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** env keys refused by sanitizeRunEnv (surfaced, never silently eaten). */
  droppedEnvKeys: string[];
}

/**
 * RunConfig → the spawnable invocation (APP-032 deliverable 1). PURE: variable
 * substitution over the bounded known set, `program` → `[interpreter, file]`,
 * `module` → `[interpreter, "-m", mod]` (module name validated — a `-`-leading
 * or exotic value must never reach python as a flag), args stay an ARRAY, env
 * keys sanitized. Returns an error STRING for configs that cannot run.
 */
export function buildRunInvocation(
  cfg: RunConfig,
  workspaceRoot: string,
  opts: { interpreter?: string; file?: string; env?: Readonly<Record<string, string>> } = {},
): RunInvocation | string {
  if (cfg.type === "compound") return "a compound config must be resolved to members first";
  if (cfg.request !== "launch") return `cannot run a request:"${cfg.request}" config`;
  const ctx: SubstitutionContext = {
    workspaceRoot,
    ...(opts.file !== undefined ? { file: opts.file } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };
  const sub = (s: string): string => substituteVars(s, ctx);

  let cmd: string;
  let args: string[];
  const kind = cfg.type === "debugpy" ? "python" : cfg.type;
  if (kind === "python") {
    const rawPy = typeof cfg.raw.python === "string" ? cfg.raw.python : undefined;
    cmd = sub(rawPy ?? opts.interpreter ?? "python3");
    if (cfg.module !== undefined) {
      const mod = sub(cfg.module);
      if (!MODULE_NAME.test(mod)) return `invalid module name: ${mod}`;
      args = ["-m", mod];
    } else if (cfg.program !== undefined) {
      const prog = sub(cfg.program);
      // a `-`-leading program (`--eval=…`, `-c import os…`) would reach the interpreter as a
      // FLAG → arbitrary code execution from an untrusted workspace launch.json. Reject it,
      // matching the `module` guard above.
      if (prog.startsWith("-")) return `invalid program (must not start with "-"): ${prog}`;
      args = [prog];
    } else {
      return "config has neither program nor module";
    }
  } else if (kind === "node") {
    cmd = "node";
    if (cfg.program === undefined) return "config has neither program nor module";
    const prog = sub(cfg.program);
    if (prog.startsWith("-")) return `invalid program (must not start with "-"): ${prog}`;
    args = [prog];
  } else {
    return `unsupported run type: ${cfg.type}`;
  }
  args = [...args, ...(cfg.args ?? []).map(sub)];

  const { env, dropped } = sanitizeRunEnv(cfg.env);
  const subbedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) subbedEnv[k] = sub(v);
  return {
    cmd,
    args,
    cwd: cfg.cwd !== undefined ? sub(cfg.cwd) : workspaceRoot,
    env: subbedEnv,
    droppedEnvKeys: dropped,
  };
}

/**
 * The debug `type` + `python` interpreter ONE raw config resolves to (APP-029, narrow
 * scope — the full DAP launch-request mapping stays in DebugPanel per this file's own
 * boundary above). Mirrors DebugPanel's `buildLaunchRequest` type/python derivation
 * exactly so adapter DETECTION checks the same adapter a launch would actually use.
 * Null cfg → the default python launch.
 */
export function debugTypeAndPython(cfg: Record<string, unknown> | null): {
  type: string;
  python?: string;
} {
  if (!cfg) return { type: "python" };
  const rawType = typeof cfg.type === "string" ? cfg.type : "python";
  const out: { type: string; python?: string } = {
    type: rawType === "debugpy" ? "python" : rawType,
  };
  if (typeof cfg.python === "string") out.python = cfg.python;
  return out;
}
