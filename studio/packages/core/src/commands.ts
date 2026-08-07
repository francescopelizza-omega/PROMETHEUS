/**
 * commands.ts — the CANONICAL COMMAND PARITY ROUTER (file 01 §11.3 / 11 §2+§5).
 *
 * ONE registry that BOTH the desktop GUI and the `prometheus` CLI route through, so
 * parity is STRUCTURAL, not aspirational: every capability is a single
 * `CommandSpec` whose `surfaces` declares which of {GUI, CLI} expose it, and
 * whose `run(ctx, args)` drives the engine through @prometheus/engine-bridge —
 * the ONLY JS->engine gateway (C5). The GUI iterates `listCommands("GUI")` to
 * build its palette; the CLI maps its argv to a spec id via `listCommands("CLI")`.
 * Neither surface re-implements the routing — they share THIS table, which is
 * what makes "anything in the GUI you can do in prometheus, and vice-versa" a
 * compile-/test-time invariant (see commands.parity.test.ts).
 *
 * This file COMPLEMENTS the existing M1 `commands/registry.ts` (the seeded,
 * hand-tuned summaries the M1 tests cover). It does NOT replace it: registry.ts
 * stays the source of the rich provider/scan summaries; THIS file is the full
 * engine-surface map (file 01 §9) every subcommand of prometheus.py + nemesis,
 * plus the sidecar verbs, expressed as data so coverage is checkable.
 *
 * GOLDEN RULE (C5): nothing here decides "safe". Security-relevant work is an
 * engine call; `gate` renders the nemesis verdict the engine-bridge computed.
 * Node built-ins only — the registry is data + thin closures.
 */
import type {
  EngineClient,
  EngineEnvelope,
  RunOptions,
  SecurityVerdict,
} from "@prometheus/engine-bridge";

/* ------------------------------------------------------------------------- *
 * Surfaces & groups
 * ------------------------------------------------------------------------- */

/** The two parity surfaces. A command may be on one or both. */
export type Surface = "GUI" | "CLI";

/**
 * Feature-area grouping, aligned to the Studio panels / file owners in §5:
 * inventory ([[06]]), security ([[03]]), catalog ([[06]]), skills ([[06]]),
 * environments ([[04]]), models ([[05]]), repos ([[06]]), apps/worldsim
 * ([[06]]), pentest ([[03]]/[[06]]), providers ([[12]]), tasks ([[10]]),
 * system (doctor/version/diagnostics).
 */
export type CommandGroup =
  | "inventory"
  | "security"
  | "catalog"
  | "skills"
  | "environments"
  | "models"
  | "repos"
  | "apps"
  | "worldsim"
  | "pentest"
  | "providers"
  | "tasks"
  | "chat"
  | "system";

/**
 * Where the command's work lands:
 *  - a prometheus.py subcommand name (e.g. "scan", "install", "worldsim"),
 *  - "nemesis:<verb>" for a direct nemesis call (the C4 arbitrary-target gate),
 *  - "sidecar:<module>.<verb>" for a python sidecar verb (envmgr/modelhub, C7),
 *  - "core:<id>" for a prom-native capability with no single engine verb
 *    (provider tiering, profiles, config) that core composes itself.
 */
export type EngineBinding =
  | { kind: "prometheus"; subcommand: PrometheusSubcommand }
  | { kind: "nemesis"; verb: NemesisVerb }
  | { kind: "sidecar"; module: "envmgr" | "modelhub"; verb: string }
  | { kind: "core"; id: string };

/**
 * The canonical prometheus.py subcommand set (file 01 §9 + probed `--help`,
 * prometheus.py 0.15.0). This is the FROZEN engine surface every CommandSpec
 * with kind:"prometheus" must name — the parity test asserts full coverage.
 */
export type PrometheusSubcommand =
  | "scan"
  | "superscan"
  | "matrix"
  | "where"
  | "purge"
  | "schedule"
  | "inventory"
  | "list"
  | "doctor"
  | "bundle"
  | "install"
  | "uninstall"
  | "status"
  | "enable"
  | "disable"
  | "skills"
  | "info"
  | "audit"
  | "scaffold-skill"
  | "sync"
  | "models"
  | "apps"
  | "worldsim"
  | "localai"
  | "pentest"
  | "vault"
  | "wizard"
  // SPECTACULAR power-up surfaces (2026-06): catalog cards + defensive audit + chat.
  | "describe"
  | "tutorial"
  | "methods"
  | "harden"
  | "chat"
  // URL-injection safeguard: scan ANY file/folder/repo for threats.
  | "secure"
  // one-command full safe maintenance (feeds + audit + integrate green skills).
  | "auto";

/** The canonical nemesis verb set (probed `nemesis --help`, 1.12.x). */
export type NemesisVerb =
  | "gate"
  | "scan"
  | "ui"
  | "ignore"
  | "verify"
  | "cache"
  | "restore"
  | "update"
  | "auth"
  | "selftest";

/* ------------------------------------------------------------------------- *
 * Args schema (a tiny, dependency-free validator)
 * ------------------------------------------------------------------------- */

/** A single declared argument of a command. */
export interface ArgSpec {
  name: string;
  /** positional (consumed by index) or a --flag. */
  kind: "positional" | "flag";
  /** value type; "boolean" flags take no value. */
  type: "string" | "number" | "boolean" | "enum";
  required?: boolean;
  /** allowed values when type:"enum". */
  choices?: readonly string[];
  description?: string;
}

/** The declared argument schema of a command. */
export interface ArgsSchema {
  positionals?: readonly ArgSpec[];
  flags?: readonly ArgSpec[];
}

/** The parsed, validated argument bag handed to a command's run(). */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | number | boolean>;
}

/** The result of validating raw args against an ArgsSchema. */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  parsed: ParsedArgs;
}

/**
 * Validate raw positionals + flags against a schema. Pure, stdlib-only.
 * - required positionals/flags must be present & non-empty
 * - number args must parse as finite numbers
 * - enum args must be one of `choices`
 * Returns every error (not just the first) so a GUI form can show them all.
 */
export function validateArgs(schema: ArgsSchema, raw: RawArgs): ValidationResult {
  const errors: string[] = [];
  const positionals: string[] = [];
  const flags: Record<string, string | number | boolean> = {};

  const decl = schema.positionals ?? [];
  for (let i = 0; i < decl.length; i++) {
    const spec = decl[i]!;
    const value = raw.positionals[i];
    if (value === undefined || value === "") {
      if (spec.required) errors.push(`missing required argument <${spec.name}>`);
      continue;
    }
    const coerced = coerce(spec, value, errors);
    if (coerced !== undefined) positionals[i] = String(coerced);
  }
  // surplus positionals are allowed (variadic tails like `pentest run -- ...`);
  // keep them verbatim so a spec can forward an open argv.
  for (let i = decl.length; i < raw.positionals.length; i++) {
    const extra = raw.positionals[i];
    if (extra !== undefined) positionals[i] = extra;
  }

  for (const spec of schema.flags ?? []) {
    const present = Object.prototype.hasOwnProperty.call(raw.flags, spec.name);
    const value = raw.flags[spec.name];
    if (!present || value === undefined || value === "") {
      if (spec.required) errors.push(`missing required flag --${spec.name}`);
      continue;
    }
    if (spec.type === "boolean") {
      flags[spec.name] = value === true || value === "true" || value === "1" || value === "";
      continue;
    }
    const coerced = coerce(spec, value, errors);
    if (coerced !== undefined) flags[spec.name] = coerced;
  }

  return { ok: errors.length === 0, errors, parsed: { positionals, flags } };
}

/** Raw, untyped argument input from a CLI argv parse or a GUI form. */
export interface RawArgs {
  positionals: readonly string[];
  flags: Readonly<Record<string, string | boolean>>;
}

function coerce(
  spec: ArgSpec,
  value: string | boolean,
  errors: string[],
): string | number | boolean | undefined {
  if (spec.type === "boolean") return value === true || value === "true";
  const s = typeof value === "boolean" ? String(value) : value;
  if (spec.type === "number") {
    const n = Number(s);
    if (!Number.isFinite(n)) {
      errors.push(`argument <${spec.name}> must be a number (got "${s}")`);
      return undefined;
    }
    return n;
  }
  if (spec.type === "enum") {
    if (!spec.choices || !spec.choices.includes(s)) {
      errors.push(
        `argument <${spec.name}> must be one of ${(spec.choices ?? []).join("|")} (got "${s}")`,
      );
      return undefined;
    }
  }
  return s;
}

/* ------------------------------------------------------------------------- *
 * The command context, result, and spec
 * ------------------------------------------------------------------------- */

/** Context handed to every CommandSpec.run — the engine client is the gateway. */
export interface RouterContext {
  /** the ONLY engine gateway (C5). */
  client: EngineClient;
  /** pass-through run options (cwd/timeout/signal/onStderr). */
  opts?: RunOptions;
}

/** The normalised result of a routed command. */
export interface RouterResult {
  id: string;
  ok: boolean;
  /** the raw engine envelope, when the command was a prometheus.py/sidecar call. */
  envelope?: EngineEnvelope;
  /** a security verdict, for nemesis gate / scan commands. */
  verdict?: SecurityVerdict;
  /** a short human summary line for the CLI / GUI toast. */
  summary: string;
}

/**
 * The canonical unit BOTH surfaces render & route through. `engineSubcommand`
 * (string form) is the stable, serialisable name the parity audit matches
 * against the engine surface; `binding` is its structured form.
 */
export interface CommandSpec {
  id: string;
  title: string;
  group: CommandGroup;
  description: string;
  /** structured binding to the engine/sidecar/nemesis/core verb. */
  binding: EngineBinding;
  /**
   * serialisable engine target, for the parity audit & docs:
   *   "scan" | "nemesis:gate" | "sidecar:envmgr.env.list" | "core:provider-list".
   */
  engineSubcommand: string;
  /** which surfaces expose this command (parity is declared, then asserted). */
  surfaces: readonly Surface[];
  /** the declared argument schema (validated before run). */
  argsSchema: ArgsSchema;
  /** does this command mutate state (install/enable/...) — drives gate/confirm UX. */
  mutates?: boolean;
  /**
   * Per-command help copy (CLI-049) — a one-line synopsis + at least one example. OPTIONAL:
   * `renderCommandHelp` synthesizes both from `description`/`id`/`argsSchema` when absent, so
   * every CLI-surfaced command still has usable help. Populate it for a richer synopsis/examples.
   * Consumed structurally by the CLI help renderer and (later) completion/manpage generators.
   */
  help?: CommandHelp;
  /** route the command through the engine client. Args are PRE-VALIDATED. */
  run(ctx: RouterContext, args: ParsedArgs): Promise<RouterResult>;
}

/** A command's help copy: a one-line synopsis + example invocations (CLI-049). */
export interface CommandHelp {
  synopsis: string;
  examples: readonly string[];
}

/* ------------------------------------------------------------------------- *
 * Small run() helpers (kept identical in spirit to registry.ts)
 * ------------------------------------------------------------------------- */

function summarize(id: string, env: EngineEnvelope): string {
  if (env.ok === false) {
    const reason = typeof env.error === "string" ? env.error : "engine returned ok:false";
    return `${id}: ${reason}`;
  }
  return `${id}: ok`;
}

function envResult(id: string, env: EngineEnvelope): RouterResult {
  return { id, ok: env.ok !== false, envelope: env, summary: summarize(id, env) };
}

/** First positional, or "" — specs that require it declare it in argsSchema. */
function arg0(args: ParsedArgs): string {
  return args.positionals[0] ?? "";
}

/**
 * Emit engine argv for the named flags present in a validated flag bag:
 *   string/number → ["--name", value]   ·   boolean true → ["--name"]
 * Absent/false flags emit nothing. This is what carries the full GUI affordance set
 * (`--only`/`--skip`/`--arm`/`--path`/`--version`/`--set-root`/…) through the parity
 * router so the CLI single-word verbs match the GUI's option surface exactly.
 */
function forwardFlags(
  flags: Record<string, string | number | boolean>,
  names: readonly string[],
): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(flags, name)) continue;
    const v = flags[name];
    if (v === undefined || v === false) continue;
    if (v === true) out.push(`--${name}`);
    else out.push(`--${name}`, String(v));
  }
  return out;
}

/** `--host a,b` → ["--host","a","--host","b"] (the engine's repeatable append flag). */
function hostArgv(flags: Record<string, string | number | boolean>): string[] {
  const v = flags.host;
  if (typeof v !== "string" || !v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .flatMap((h) => ["--host", h]);
}

/** The §1 engine global flags, in the canonical BEFORE-subcommand order. */
function globalFlagArgv(flags: Record<string, string | number | boolean>): string[] {
  const out: string[] = [];
  if (flags["dry-run"] === true) out.push("--dry-run");
  if (flags.yes === true) out.push("--yes");
  if (flags.strict === true) out.push("--strict");
  if (flags.force === true) out.push("--force");
  if (flags["no-gate"] === true) out.push("--no-gate");
  const gateMode = flags["gate-mode"];
  if (gateMode === "enforce" || gateMode === "warn" || gateMode === "off") {
    out.push("--gate-mode", gateMode);
  }
  if (flags.verbose === true) out.push("--verbose");
  return out;
}

/**
 * The §1 globals as declared ArgSpecs, merged into every mutating spec's schema so
 * validateArgs PASSES them through (else --no-gate/--gate-mode/--verbose are dropped
 * before run() can forward them — the route.ts "globals leak" the audit flagged).
 */
const GLOBAL_FLAG_SPECS: readonly ArgSpec[] = [
  { name: "dry-run", kind: "flag", type: "boolean" },
  { name: "yes", kind: "flag", type: "boolean" },
  { name: "strict", kind: "flag", type: "boolean" },
  { name: "force", kind: "flag", type: "boolean" },
  { name: "no-gate", kind: "flag", type: "boolean" },
  { name: "gate-mode", kind: "flag", type: "enum", choices: ["enforce", "warn", "off"] },
  { name: "verbose", kind: "flag", type: "boolean" },
];

/** Build the serialisable engineSubcommand string from a binding. */
function bindingTarget(b: EngineBinding): string {
  switch (b.kind) {
    case "prometheus":
      return b.subcommand;
    case "nemesis":
      return `nemesis:${b.verb}`;
    case "sidecar":
      return `sidecar:${b.module}.${b.verb}`;
    case "core":
      return `core:${b.id}`;
  }
}

/* ------------------------------------------------------------------------- *
 * Spec builders — reduce boilerplate for the common shapes
 * ------------------------------------------------------------------------- */

interface SpecInit {
  id: string;
  title: string;
  group: CommandGroup;
  description: string;
  binding: EngineBinding;
  surfaces?: readonly Surface[];
  argsSchema?: ArgsSchema;
  mutates?: boolean;
  help?: CommandHelp;
  run(ctx: RouterContext, args: ParsedArgs): Promise<RouterResult>;
}

function spec(init: SpecInit): CommandSpec {
  return {
    id: init.id,
    title: init.title,
    group: init.group,
    description: init.description,
    binding: init.binding,
    engineSubcommand: bindingTarget(init.binding),
    surfaces: init.surfaces ?? ["GUI", "CLI"],
    argsSchema: init.argsSchema ?? {},
    mutates: init.mutates ?? false,
    ...(init.help ? { help: init.help } : {}),
    run: init.run,
  };
}

const NAME_ARG: ArgsSchema = {
  positionals: [{ name: "name", kind: "positional", type: "string", required: true }],
};

const TARGET_ARG: ArgsSchema = {
  positionals: [{ name: "target", kind: "positional", type: "string", required: true }],
};

const ACTION_ARG: ArgsSchema = {
  positionals: [{ name: "action", kind: "positional", type: "string", required: false }],
};

/**
 * A read-only prometheus.py command that takes NO positional (scan/list/...).
 * Routes through the typed client method when one exists, else runPrometheus.
 */
function roSpec(
  init: Omit<SpecInit, "run" | "binding"> & {
    subcommand: PrometheusSubcommand;
    call?: (ctx: RouterContext) => Promise<EngineEnvelope>;
  },
): CommandSpec {
  return spec({
    ...init,
    binding: { kind: "prometheus", subcommand: init.subcommand },
    run: async (ctx) => {
      const env = init.call
        ? await init.call(ctx)
        : await ctx.client.runPrometheus([init.subcommand], ctx.opts);
      return envResult(init.id, env);
    },
  });
}

/** A prometheus.py command that takes a single required NAME positional. */
function nameSpec(
  init: Omit<SpecInit, "run" | "binding" | "argsSchema"> & {
    subcommand: PrometheusSubcommand;
    call?: (ctx: RouterContext, name: string) => Promise<EngineEnvelope>;
  },
): CommandSpec {
  return spec({
    ...init,
    binding: { kind: "prometheus", subcommand: init.subcommand },
    argsSchema: NAME_ARG,
    run: async (ctx, args) => {
      const name = arg0(args);
      const env = init.call
        ? await init.call(ctx, name)
        : await ctx.client.runPrometheus([init.subcommand, name], ctx.opts);
      return envResult(init.id, env);
    },
  });
}

/**
 * A prometheus.py "manager" command (apps/worldsim/pentest/localai/models/vault)
 * shaped as `<subcommand> [action] [tool]`. Forwards the parsed positionals
 * verbatim — the engine owns the action grammar, prometheus does not re-invent it.
 */
function managerSpec(
  init: Omit<SpecInit, "run" | "binding" | "argsSchema"> & {
    subcommand: PrometheusSubcommand;
    argsSchema?: ArgsSchema;
    /** flag names (declared in argsSchema) to forward to the engine — the per-verb GUI affordances. */
    flagForward?: readonly string[];
  },
): CommandSpec {
  const base = init.argsSchema ?? ACTION_ARG;
  // merge the §1 globals into the schema so validateArgs forwards them (globals leak fix).
  const argsSchema: ArgsSchema = {
    positionals: base.positionals,
    flags: [...(base.flags ?? []), ...GLOBAL_FLAG_SPECS],
  };
  return spec({
    ...init,
    binding: { kind: "prometheus", subcommand: init.subcommand },
    argsSchema,
    run: async (ctx, args) => {
      const tail = args.positionals.filter((p) => p !== undefined && p !== "");
      const flagArgv = forwardFlags(args.flags, init.flagForward ?? []);
      // globals BEFORE the subcommand (engine contract), then positionals, then per-verb flags.
      const env = await ctx.client.runPrometheus(
        [...globalFlagArgv(args.flags), init.subcommand, ...tail, ...flagArgv],
        ctx.opts,
      );
      return envResult(init.id, env);
    },
  });
}

/* ------------------------------------------------------------------------- *
 * THE CANONICAL REGISTRY
 * Covers the full engine surface from file 01 §9 + nemesis gate (C4):
 *   scan superscan matrix where list info status audit doctor install uninstall
 *   enable disable bundle skills inventory sync scaffold-skill schedule purge
 *   vault models apps worldsim localai pentest wizard  +  nemesis gate
 * plus the sidecar (env-list / model-hw) and the core provider router.
 * ------------------------------------------------------------------------- */

export const COMMAND_SPECS: readonly CommandSpec[] = Object.freeze([
  /* ---- inventory / read-only ([[06]]) ---------------------------------- */
  roSpec({
    id: "scan",
    title: "Scan agents",
    group: "inventory",
    description: "Detect AI agent CLIs installed on this machine (prometheus.py scan).",
    subcommand: "scan",
    call: (ctx) => ctx.client.scan(ctx.opts),
  }),
  roSpec({
    id: "superscan",
    title: "Super-scan",
    group: "inventory",
    description: "Deep inventory: every agent installed/absent/forgotten + counts + prereqs.",
    subcommand: "superscan",
    call: (ctx) => ctx.client.superscan(ctx.opts),
  }),
  roSpec({
    id: "matrix",
    title: "Reach matrix",
    group: "inventory",
    description: "Which tool can go in which agent (native / sync / no).",
    subcommand: "matrix",
    call: (ctx) => ctx.client.matrix(ctx.opts),
  }),
  roSpec({
    id: "inventory",
    title: "Re-scan installed",
    group: "inventory",
    description:
      "Re-scan every detected agent for ALL installed plugins/skills/MCP (managed + foreign).",
    subcommand: "inventory",
  }),
  nameSpec({
    id: "where",
    title: "Where does it install?",
    group: "catalog",
    description: "Preview install destinations (scope + per-agent path) before installing.",
    subcommand: "where",
    call: (ctx, name) => ctx.client.where(name, ctx.opts),
  }),

  /* ---- system / health ------------------------------------------------- */
  roSpec({
    id: "doctor",
    title: "Doctor",
    group: "system",
    description: "Check OS, agents, git, and paths health (prometheus.py doctor).",
    subcommand: "doctor",
  }),
  spec({
    id: "wizard",
    title: "Install wizard",
    group: "system",
    description: "Interactive terminal menu (install / uninstall / browse). CLI/TUI only.",
    binding: { kind: "prometheus", subcommand: "wizard" },
    surfaces: ["CLI"],
    run: async (ctx) => envResult("wizard", await ctx.client.runPrometheus(["wizard"], ctx.opts)),
  }),

  /* ---- catalog ([[06]]) ------------------------------------------------ */
  roSpec({
    id: "list",
    title: "List plugins",
    group: "catalog",
    description: "List registered plugins and per-agent state (prometheus.py list).",
    subcommand: "list",
    call: (ctx) => ctx.client.list(ctx.opts),
  }),
  nameSpec({
    id: "info",
    title: "Plugin info",
    group: "catalog",
    description: "Show details for one plugin (prometheus.py info <name>).",
    subcommand: "info",
    call: (ctx, name) => ctx.client.info(name, ctx.opts),
  }),
  nameSpec({
    id: "status",
    title: "Plugin status",
    group: "catalog",
    description: "Install + enabled/disabled state of a plugin & its components.",
    subcommand: "status",
    call: (ctx, name) => ctx.client.status(name, ctx.opts),
  }),
  nameSpec({
    id: "audit",
    title: "Audit plugin",
    group: "security",
    description:
      "Security-scan a plugin's install artifacts — registry NAME only, no --target (C4).",
    subcommand: "audit",
  }),
  spec({
    id: "secure",
    title: "Scan for threats",
    group: "security",
    description:
      "Scan ANY file / archive / folder / repo (or --full = your home dir) for threats " +
      "with nemesis and report (prometheus.py secure).",
    binding: { kind: "prometheus", subcommand: "secure" },
    argsSchema: {
      positionals: [{ name: "target", kind: "positional", type: "string", required: false }],
      flags: [
        { name: "full", kind: "flag", type: "boolean", description: "scan the whole home dir" },
      ],
    },
    run: async (ctx, args) => {
      const target = args.positionals[0];
      const argv = ["secure"];
      if (target) argv.push(target);
      if (args.flags.full === true) argv.push("--full");
      const env = await ctx.client.runPrometheus(argv, ctx.opts);
      return envResult("secure", env);
    },
  }),
  spec({
    id: "auto",
    title: "Auto maintenance",
    group: "security",
    description:
      "One-command full safe maintenance: refresh nemesis feeds + audit/pin installed sources " +
      "(quarantine drift) + integrate nemesis-green skills (prometheus.py auto).",
    binding: { kind: "prometheus", subcommand: "auto" },
    argsSchema: {
      flags: [
        {
          name: "defang",
          kind: "flag",
          type: "boolean",
          description: "also wipe non-official URLs from installed sources",
        },
      ],
    },
    mutates: true,
    run: async (ctx, args) => {
      const argv = ["auto"];
      if (args.flags.defang === true) argv.push("--defang");
      const env = await ctx.client.runPrometheus(argv, ctx.opts);
      return envResult("auto", env);
    },
  }),
  roSpec({
    id: "bundle",
    title: "Install official bundle",
    group: "catalog",
    description: "Install the official Anthropic bundle in one run (nemesis-gated).",
    subcommand: "bundle",
    mutates: true,
  }),

  /* ---- catalog cards (SPECTACULAR): describe / tutorial / methods ------- */
  nameSpec({
    id: "describe",
    title: "Describe a catalog id",
    group: "catalog",
    description:
      "Rich card for ANY catalog id (plugin/model/app/open-model/documented): what / repo / " +
      "license / security / installable / how to act (prometheus.py describe <id>).",
    subcommand: "describe",
  }),
  nameSpec({
    id: "tutorial",
    title: "Tutorial (Learn more)",
    group: "catalog",
    description:
      "Print the deep dossier for an id — the GUI's 'Learn more' (prometheus.py tutorial <id>).",
    subcommand: "tutorial",
  }),
  nameSpec({
    id: "methods",
    title: "Install methods",
    group: "catalog",
    description:
      "Every documented install method for an id, from its dossier (prometheus.py methods <id>).",
    subcommand: "methods",
  }),

  /* ---- catalog state-changing (gated by the engine, C5) ---------------- */
  spec({
    id: "install",
    title: "Install plugin",
    group: "catalog",
    description:
      "Install a plugin ('all' / 'official-bundle' / name). The ENGINE runs nemesis " +
      "and returns forced_danger/ok:false on BLOCK — JS never pre-judges (C5).",
    binding: { kind: "prometheus", subcommand: "install" },
    mutates: true,
    argsSchema: {
      positionals: [{ name: "name", kind: "positional", type: "string", required: true }],
      flags: [
        {
          name: "only",
          kind: "flag",
          type: "string",
          description: "install ONLY these components (comma-sep)",
        },
        {
          name: "skip",
          kind: "flag",
          type: "string",
          description: "install all EXCEPT these (comma-sep)",
        },
        {
          name: "host",
          kind: "flag",
          type: "string",
          description: "restrict to detected agents (comma-sep / repeatable)",
        },
        {
          name: "arm",
          kind: "flag",
          type: "boolean",
          description: "auto-arm so it self-fires (enabledPlugins + marketplaces)",
        },
        { name: "dry-run", kind: "flag", type: "boolean" },
        { name: "yes", kind: "flag", type: "boolean" },
        { name: "strict", kind: "flag", type: "boolean" },
        {
          name: "force",
          kind: "flag",
          type: "boolean",
          description: "override a nemesis BLOCK (forced_danger) — typed-confirm gated upstream",
        },
        { name: "no-gate", kind: "flag", type: "boolean" },
        { name: "gate-mode", kind: "flag", type: "enum", choices: ["enforce", "warn", "off"] },
        { name: "verbose", kind: "flag", type: "boolean" },
      ],
    },
    run: async (ctx, args) => {
      const f = args.flags;
      // mirror engine-bridge LifecycleClient.install argv EXACTLY (globals BEFORE the
      // subcommand) so the single-word `prometheus install` matches the GUI affordance set.
      const argv = [
        ...globalFlagArgv(f),
        "install",
        arg0(args),
        ...hostArgv(f),
        ...forwardFlags(f, ["only", "skip"]),
        ...(f.arm === true ? ["--arm"] : []),
      ];
      return envResult("install", await ctx.client.runPrometheus(argv, ctx.opts));
    },
  }),
  spec({
    id: "uninstall",
    title: "Uninstall plugin",
    group: "catalog",
    description:
      "Remove a plugin ('all' / 'official-bundle' / name); subset via --only/--skip, per-agent via --host.",
    binding: { kind: "prometheus", subcommand: "uninstall" },
    mutates: true,
    argsSchema: {
      positionals: [{ name: "name", kind: "positional", type: "string", required: true }],
      flags: [
        { name: "only", kind: "flag", type: "string" },
        { name: "skip", kind: "flag", type: "string" },
        { name: "host", kind: "flag", type: "string" },
        { name: "dry-run", kind: "flag", type: "boolean" },
        { name: "yes", kind: "flag", type: "boolean" },
        { name: "no-gate", kind: "flag", type: "boolean" },
        { name: "gate-mode", kind: "flag", type: "enum", choices: ["enforce", "warn", "off"] },
        { name: "verbose", kind: "flag", type: "boolean" },
      ],
    },
    run: async (ctx, args) => {
      const f = args.flags;
      const argv = [
        ...globalFlagArgv(f),
        "uninstall",
        arg0(args),
        ...hostArgv(f),
        ...forwardFlags(f, ["only", "skip"]),
      ];
      return envResult("uninstall", await ctx.client.runPrometheus(argv, ctx.opts));
    },
  }),
  spec({
    id: "enable",
    title: "Enable plugin",
    group: "catalog",
    description:
      "Re-arm a disabled plugin/component (settings.json / on-disk); --component hooks|mcp, --host for foreign.",
    binding: { kind: "prometheus", subcommand: "enable" },
    mutates: true,
    argsSchema: {
      positionals: [{ name: "name", kind: "positional", type: "string", required: true }],
      flags: [
        { name: "only", kind: "flag", type: "string" },
        { name: "component", kind: "flag", type: "enum", choices: ["hooks", "mcp"] },
        { name: "host", kind: "flag", type: "string" },
      ],
    },
    run: async (ctx, args) => {
      const f = args.flags;
      const argv = [
        "enable",
        arg0(args),
        ...forwardFlags(f, ["only", "component"]),
        ...hostArgv(f),
      ];
      return envResult("enable", await ctx.client.runPrometheus(argv, ctx.opts));
    },
  }),
  spec({
    id: "disable",
    title: "Disable plugin",
    group: "catalog",
    description:
      "Turn off a plugin/component WITHOUT uninstalling (reversible); same flags as enable.",
    binding: { kind: "prometheus", subcommand: "disable" },
    mutates: true,
    argsSchema: {
      positionals: [{ name: "name", kind: "positional", type: "string", required: true }],
      flags: [
        { name: "only", kind: "flag", type: "string" },
        { name: "component", kind: "flag", type: "enum", choices: ["hooks", "mcp"] },
        { name: "host", kind: "flag", type: "string" },
      ],
    },
    run: async (ctx, args) => {
      const f = args.flags;
      const argv = [
        "disable",
        arg0(args),
        ...forwardFlags(f, ["only", "component"]),
        ...hostArgv(f),
      ];
      return envResult("disable", await ctx.client.runPrometheus(argv, ctx.opts));
    },
  }),
  nameSpec({
    id: "sync",
    title: "Sync skill across agents",
    group: "skills",
    description: "Replicate an installed SKILL.md into other agents (cross-CLI portability).",
    subcommand: "sync",
    mutates: true,
  }),
  nameSpec({
    id: "scaffold-skill",
    title: "Scaffold a skill",
    group: "skills",
    description: "Write an auto-firing SKILL.md into ~/.claude/skills/.",
    subcommand: "scaffold-skill",
    mutates: true,
  }),
  managerSpec({
    id: "skills",
    title: "Skills manager",
    group: "skills",
    description: "list / enable / disable / mute installed SKILL.md folders.",
    subcommand: "skills",
    argsSchema: {
      positionals: [
        {
          name: "action",
          kind: "positional",
          type: "enum",
          required: false,
          choices: ["list", "enable", "disable", "mute"],
        },
        { name: "name", kind: "positional", type: "string", required: false },
      ],
    },
  }),

  /* ---- security ([[03]]) — the C4 arbitrary-target gate ---------------- */
  spec({
    id: "gate",
    title: "Gate a target",
    group: "security",
    description:
      "Security-gate an arbitrary path / git URL / owner-repo through nemesis (C4). " +
      "FAIL-CLOSED: missing/timed-out scanner => verdict 'error' => BLOCK (C5).",
    binding: { kind: "nemesis", verb: "gate" },
    argsSchema: TARGET_ARG,
    help: {
      synopsis: "prometheus gate <path|git-url|owner/repo> [--fresh] [--sign] [--policy <file>]",
      examples: [
        "prometheus gate .                      # gate the current directory",
        "prometheus gate owner/repo --fresh     # bypass the verdict cache",
        "prometheus gate ./pkg --json           # machine-readable verdict",
      ],
    },
    run: async (ctx, args) => {
      const target = arg0(args);
      const verdict = await ctx.client.gate(target, ctx.opts);
      const blocked = verdict.verdict === "block" || verdict.verdict === "error";
      return {
        id: "gate",
        ok: !blocked,
        verdict,
        summary: `gate ${target}: ${verdict.verdict} (risk ${verdict.risk_score}, ${verdict.findings.length} findings)`,
      };
    },
  }),
  spec({
    id: "secure-scan",
    title: "Scan a path / package / repo",
    group: "security",
    description:
      "The universal 'is this safe?' scan — routes to nemesis (NOT a JS heuristic). " +
      "Same fail-closed semantics as gate (C5).",
    binding: { kind: "nemesis", verb: "gate" },
    argsSchema: TARGET_ARG,
    run: async (ctx, args) => {
      const target = arg0(args);
      const verdict = await ctx.client.gate(target, ctx.opts);
      const blocked = verdict.verdict === "block" || verdict.verdict === "error";
      return {
        id: "secure-scan",
        ok: !blocked,
        verdict,
        summary: `secure-scan ${target}: ${verdict.verdict} (${verdict.findings.length} findings)`,
      };
    },
  }),
  spec({
    id: "nemesis",
    title: "Nemesis threat scan",
    group: "security",
    description:
      "The FREE nemesis threat scan (backdoors / malware / supply-chain / code threats) of any " +
      "path, git URL, or owner/repo — the SAME fail-closed verdict the install gate uses (C5), " +
      "available identically from the CLI (`prometheus nemesis <target>` / `/nemesis`) and the app GUI.",
    binding: { kind: "nemesis", verb: "gate" },
    argsSchema: TARGET_ARG,
    run: async (ctx, args) => {
      const target = arg0(args);
      const verdict = await ctx.client.gate(target, ctx.opts);
      const blocked = verdict.verdict === "block" || verdict.verdict === "error";
      return {
        id: "nemesis",
        ok: !blocked,
        verdict,
        summary: `nemesis ${target}: ${verdict.verdict} (risk ${verdict.risk_score}, ${verdict.findings.length} findings)`,
      };
    },
  }),
  nameSpec({
    id: "purge",
    title: "Purge a forgotten agent",
    group: "security",
    description: "Back up + remove a forgotten agent's config/state (not the binary).",
    subcommand: "purge",
    mutates: true,
  }),
  roSpec({
    id: "harden",
    title: "Harden your vault (defensive self-audit)",
    group: "security",
    description:
      "Read-only, THIS-machine-only posture audit (firewall / open ports / ssh / disk-encryption / " +
      "secret-perms) + concrete fixes. Authorized-by-design; points to `pentest` for deeper testing.",
    subcommand: "harden",
  }),

  /* ---- scheduled watchers ([[10]]) ------------------------------------- */
  nameSpec({
    id: "schedule",
    title: "Schedule a watcher",
    group: "tasks",
    description: "Scaffold a scheduled headless watcher (cron/launchd) — confirm-gated.",
    subcommand: "schedule",
    mutates: true,
  }),

  /* ---- environments ([[04]], via the envmgr sidecar, C7) --------------- */
  spec({
    id: "env-list",
    title: "List environments",
    group: "environments",
    description: "List Python environments (venv/conda/system) via the envmgr sidecar (env.list).",
    binding: { kind: "sidecar", module: "envmgr", verb: "env.list" },
    run: async (ctx) => {
      const env = await ctx.client.runPrometheus(["sidecar", "envmgr", "env.list"], ctx.opts);
      const envs = Array.isArray(env.environments) ? (env.environments as unknown[]) : [];
      return {
        ...envResult("env-list", env),
        summary:
          env.ok === false ? summarize("env-list", env) : `env-list: ${envs.length} environments`,
      };
    },
  }),

  /* ---- models ([[05]]) -------------------------------------------------- */
  spec({
    id: "model-hw",
    title: "Scan hardware for model fit",
    group: "models",
    description: "Probe host hardware for model-fit scoring (modelhub hw.scan, C7).",
    binding: { kind: "sidecar", module: "modelhub", verb: "hw.scan" },
    run: async (ctx) => {
      const env = await ctx.client.runPrometheus(["sidecar", "modelhub", "hw.scan"], ctx.opts);
      const gb =
        typeof env.usable_weight_gb === "number"
          ? `${env.usable_weight_gb} GB usable`
          : "hw scanned";
      return {
        ...envResult("model-hw", env),
        summary: env.ok === false ? summarize("model-hw", env) : `model-hw: ${gb}`,
      };
    },
  }),
  managerSpec({
    id: "models",
    title: "Model-running tools",
    group: "models",
    description:
      "Install/manage local model-running tools (AirLLM, FlashAttention, Odysseus, ...). " +
      "`models config --set-root DIR` sets the default install folder; per-tool --path/--version/--method.",
    subcommand: "models",
    argsSchema: {
      positionals: [{ name: "action", kind: "positional", type: "string", required: false }],
      flags: [
        { name: "path", kind: "flag", type: "string" },
        {
          name: "set-root",
          kind: "flag",
          type: "string",
          description: "models config: default install folder (persisted)",
        },
        {
          name: "show",
          kind: "flag",
          type: "boolean",
          description: "models config: print the current default folder",
        },
        { name: "version", kind: "flag", type: "string" },
        { name: "method", kind: "flag", type: "string" },
        { name: "target-python", kind: "flag", type: "string" },
        { name: "max-jobs", kind: "flag", type: "string" },
        { name: "cuda", kind: "flag", type: "string" },
        { name: "fa-version", kind: "flag", type: "string" },
      ],
    },
    flagForward: [
      "path",
      "set-root",
      "show",
      "version",
      "method",
      "target-python",
      "max-jobs",
      "cuda",
      "fa-version",
    ],
  }),
  managerSpec({
    id: "localai",
    title: "Local-AI catalog & re-point",
    group: "models",
    description:
      "Audit AI repos (paid-API vs free-local) + catalog of open models + the re-point recipe.",
    subcommand: "localai",
  }),

  /* ---- repos / vault ([[06]]) ------------------------------------------ */
  managerSpec({
    id: "vault",
    title: "Repo vault",
    group: "repos",
    description:
      "Offline versioned ZIP archive of every repo (status / invoke / invoke-all / rollback).",
    subcommand: "vault",
    argsSchema: {
      positionals: [
        {
          name: "action",
          kind: "positional",
          type: "enum",
          required: false,
          choices: ["status", "invoke", "invoke-all", "rollback"],
        },
      ],
    },
  }),

  /* ---- self-hosted apps / world-sim ([[06]]) --------------------------- */
  managerSpec({
    id: "apps",
    title: "Self-hosted apps",
    group: "apps",
    description:
      "Install/manage self-hosted apps & repos (yt-dlp, ollama, n8n, penpot, ...); --path target dir, --version rollback.",
    subcommand: "apps",
    argsSchema: {
      positionals: [{ name: "action", kind: "positional", type: "string", required: false }],
      flags: [
        { name: "path", kind: "flag", type: "string" },
        { name: "version", kind: "flag", type: "string" },
      ],
    },
    flagForward: ["path", "version"],
  }),
  managerSpec({
    id: "worldsim",
    title: "World-simulation engines",
    group: "worldsim",
    description:
      "Install/manage agent-based World-Simulation engines (MiroFish, ...; docker-compose); --path, --version.",
    subcommand: "worldsim",
    argsSchema: {
      positionals: [{ name: "action", kind: "positional", type: "string", required: false }],
      flags: [
        { name: "path", kind: "flag", type: "string" },
        { name: "version", kind: "flag", type: "string" },
      ],
    },
    flagForward: ["path", "version"],
  }),

  /* ---- pentest ([[03]]/[[06]]) — ROE-gated, CLI/GUI panel -------------- */
  managerSpec({
    id: "pentest",
    title: "Pentest sandbox",
    group: "pentest",
    description:
      "AUTHORIZED pentest tools + AIs, each run inside an airgapped, ROE-gated sandbox. " +
      "build --kali (heavier image); shell/run --allow-net (in-scope egress); scope --init.",
    subcommand: "pentest",
    argsSchema: {
      positionals: [{ name: "action", kind: "positional", type: "string", required: false }],
      flags: [
        { name: "kali", kind: "flag", type: "boolean" },
        { name: "allow-net", kind: "flag", type: "boolean" },
        { name: "init", kind: "flag", type: "boolean" },
      ],
    },
    flagForward: ["kali", "allow-net", "init"],
  }),

  /* ---- chat (SPECTACULAR): agentic-local / terminal-CLI ---------------- */
  spec({
    id: "chat",
    title: "Chat (agentic local / terminal CLI)",
    group: "chat",
    description:
      "Agentic chat with a FREE local model (--local, runs in-app via ollama/lmstudio), OR a terminal " +
      "chat with a paid CLI (--cli claude|codex|gemini|cursor|opencode; preview → --open, --tmux, " +
      "--bypass typed-confirm, --system-prompt). The engine enforces local≠paid (C5).",
    binding: { kind: "prometheus", subcommand: "chat" },
    argsSchema: {
      positionals: [{ name: "message", kind: "positional", type: "string", required: false }],
      flags: [
        {
          name: "local",
          kind: "flag",
          type: "string",
          description: "local model tag (agentic, free)",
        },
        {
          name: "cli",
          kind: "flag",
          type: "enum",
          choices: ["claude", "codex", "gemini", "cursor", "opencode"],
          description: "paid CLI for a terminal chat",
        },
        { name: "model", kind: "flag", type: "string" },
        { name: "runner", kind: "flag", type: "enum", choices: ["ollama", "lmstudio"] },
        { name: "system-prompt", kind: "flag", type: "string", description: "system-prompt file" },
        { name: "replace-system", kind: "flag", type: "boolean" },
        {
          name: "bypass",
          kind: "flag",
          type: "boolean",
          description: "skip permissions (typed-confirm gated)",
        },
        {
          name: "tmux",
          kind: "flag",
          type: "boolean",
          description: "wrap the terminal chat in tmux",
        },
        { name: "open", kind: "flag", type: "boolean", description: "launch (else preview only)" },
      ],
    },
    run: async (ctx, args) => {
      const f = args.flags;
      const argv: string[] = ["chat"];
      if (typeof f.local === "string") argv.push("--local", f.local);
      if (typeof f.cli === "string") argv.push("--cli", f.cli);
      if (typeof f.model === "string") argv.push("--model", f.model);
      if (typeof f.runner === "string") argv.push("--runner", f.runner);
      if (typeof f["system-prompt"] === "string") argv.push("--system-prompt", f["system-prompt"]);
      if (f["replace-system"] === true) argv.push("--replace-system");
      if (f.bypass === true) argv.push("--bypass");
      if (f.tmux === true) argv.push("--tmux");
      if (f.open === true) argv.push("--open");
      const msg = arg0(args);
      if (msg) argv.push(msg);
      return envResult("chat", await ctx.client.runPrometheus(argv, ctx.opts));
    },
  }),

  /* ---- providers ([[12]]) — prom-native, composed by core -------------- */
  spec({
    id: "provider-list",
    title: "List providers",
    group: "providers",
    description:
      "List inference providers with their C11 promotion tier + cost light (Tier-A first). " +
      "prom-native: composed by core from providers.config.json, no single engine verb.",
    binding: { kind: "core", id: "provider-list" },
    run: async () => {
      // The full provider tiering lives in commands/registry.ts (the M1 surface)
      // and providers/policy.ts. Here the parity router exposes the capability and
      // delegates rendering to that owner; this thin form reports availability so
      // the spec is invokable on BOTH surfaces without duplicating the policy.
      return {
        id: "provider-list",
        ok: true,
        summary: "provider-list: see @prometheus/core registry (C11 promotion + cost lights)",
      };
    },
  }),
]);

/* ------------------------------------------------------------------------- *
 * Lookup + the router
 * ------------------------------------------------------------------------- */

const BY_ID = new Map<string, CommandSpec>(COMMAND_SPECS.map((c) => [c.id, c]));

/** O(1) lookup of a CommandSpec by id (undefined if unknown). */
export function getCommand(id: string): CommandSpec | undefined {
  return BY_ID.get(id);
}

/** Every CommandSpec, or just those a given surface exposes (GUI palette / CLI tree). */
export function listCommands(surface?: Surface): readonly CommandSpec[] {
  if (!surface) return COMMAND_SPECS;
  return COMMAND_SPECS.filter((c) => c.surfaces.includes(surface));
}

/** CommandSpecs in one feature group (for sectioned help / panels). */
export function commandsByGroup(group: CommandGroup): CommandSpec[] {
  return COMMAND_SPECS.filter((c) => c.group === group);
}

/** Every engineSubcommand target the registry binds (for the coverage audit). */
export function engineTargets(): string[] {
  return COMMAND_SPECS.map((c) => c.engineSubcommand);
}

/** The set of prometheus.py subcommands the registry covers. */
export function coveredPrometheusSubcommands(): Set<PrometheusSubcommand> {
  const out = new Set<PrometheusSubcommand>();
  for (const c of COMMAND_SPECS) {
    if (c.binding.kind === "prometheus") out.add(c.binding.subcommand);
  }
  return out;
}

/**
 * The router: validate args against the spec, then route through the engine
 * client. The SINGLE entry point both `prometheus` and the GUI call — this is what
 * makes parity structural. Throws on unknown id or invalid args (callers render
 * the error). The spec's run() NEVER decides "safe" (C5).
 */
export async function invoke(
  id: string,
  ctx: RouterContext,
  raw: RawArgs = { positionals: [], flags: {} },
): Promise<RouterResult> {
  const cmd = BY_ID.get(id);
  if (!cmd) throw new Error(`unknown command: ${id}`);
  const validation = validateArgs(cmd.argsSchema, raw);
  if (!validation.ok) {
    throw new Error(`invalid arguments for "${id}": ${validation.errors.join("; ")}`);
  }
  return cmd.run(ctx, validation.parsed);
}

/** Convenience: build a RawArgs from a positional list + optional flag bag. */
export function rawArgs(
  positionals: readonly string[] = [],
  flags: Readonly<Record<string, string | boolean>> = {},
): RawArgs {
  return { positionals, flags };
}
