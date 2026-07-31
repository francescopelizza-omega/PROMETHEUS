/**
 * commands/help.ts — `prom help [topic]` / `prom <cmd> --help` / the global usage screen.
 *
 * Per-command help (CLI-049) is generated from the central CommandSpec registry: `renderCommandHelp`
 * renders a spec's synopsis (explicit `spec.help` or synthesized from `description`/`argsSchema`),
 * a flag/positional table, and examples. Non-spec CLI verbs (config/profile/updates/… and the §2
 * trees) get help from `CLI_NATIVE_HELP`. An unknown topic suggests the nearest known one (reusing
 * the CLI-045 `nearestKey`). Static text, no engine call.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArgSpec, CommandSpec } from "@prometheus/core";
import { cliProfiles, getCommandSpec, listCommandSpecs } from "@prometheus/core";

import type { CliContext, CommandOutcome } from "../context.js";
import { c } from "../render.js";
import { ROUTED_VERBS } from "../route-table.js";

/**
 * Resolve the CLI's real version from the nearest `package.json` named "@prometheus/cli", walking up
 * from THIS module (CLI-086). MODULE-relative (`import.meta.url`), never `process.cwd()`, so it holds
 * under tsx-dev, `dist/`, and bundled contexts from any working directory. Falls back to "0.0.0" only
 * when no cli package.json is locatable (a broken build) — the regression test forbids that in-tree.
 */
function resolvePromVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg?.name === "@prometheus/cli" && typeof pkg.version === "string") return pkg.version;
      } catch {
        /* not here / unreadable — keep walking up */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through to the fallback */
  }
  return "0.0.0";
}

/** The CLI's version (from apps/cli/package.json). Exported name is stable (6 existing consumers). */
export const PROM_VERSION = resolvePromVersion();

/**
 * Help for CLI verbs NOT in the CommandSpec registry — the prom-native commands (config/profile/
 * updates/sessions/mcp/…) and the §2 lifecycle trees whose spec ids don't match the verb (env→
 * env-list, model→model-hw, …). One-line synopsis + ≥1 example each; keeps `prom <verb> --help`
 * useful for every real command, not just the spec'd ones.
 */
const CLI_NATIVE_HELP: Record<string, { synopsis: string; examples: readonly string[] }> = {
  updates: { synopsis: "prom updates [--json]", examples: ["prom updates", "prom updates --json"] },
  config: {
    synopsis: "prom config <path | get <key> | set <key> <val> | list> [--json]",
    examples: ["prom config list", "prom config set profile.active ci"],
  },
  profile: {
    synopsis: "prom profile <list | use <name> | new <name> [--seed b] | edit <name>>",
    examples: [
      "prom profile list",
      "prom profile use ci",
      "prom profile new mine --seed local-safe",
    ],
  },
  sessions: {
    synopsis: "prom sessions <list | search <q> | fork <id> | delete <id>>",
    examples: ["prom sessions list", "prom sessions search auth"],
  },
  mcp: {
    synopsis: "prom mcp <list | add <name> --cmd <bin> | add <name> --url <https> | remove | test>",
    examples: ["prom mcp list", "prom mcp add fs --cmd node --args server.mjs"],
  },
  keymap: { synopsis: "prom keymap list [--preset N]", examples: ["prom keymap list"] },
  tokens: {
    synopsis: "prom tokens [--paid | all | nano]",
    examples: ["prom tokens", "prom tokens --paid"],
  },
  quarantine: {
    synopsis: "prom quarantine <list | restore <vault-dir> | purge <dir>|--all>",
    examples: ["prom quarantine list", "prom quarantine restore <dir>"],
  },
  env: {
    synopsis: "prom env <list | create | clone | delete | use | export | import | doctor | ...>",
    examples: ["prom env list", "prom env create myenv"],
  },
  model: {
    synopsis:
      "prom model <hw | list | search | info | fit | pull | serve | stop | endpoints | ...>",
    examples: ["prom model list", "prom model pull qwen2.5-coder:7b"],
  },
  repo: {
    synopsis: "prom repo <add | list | status | update | pin | branch | rescan | remove | vault>",
    examples: ["prom repo list", "prom repo add https://github.com/o/r"],
  },
  metadata: {
    synopsis: "prom metadata <inspect | scrub | edit | timestomp> <file>",
    examples: ["prom metadata inspect photo.jpg"],
  },
  provider: {
    synopsis: "prom provider <list | show | connect | status | disconnect | enable-metered>",
    examples: ["prom provider list", "prom provider connect openai"],
  },
  agents: {
    synopsis: "prom agents <list | attach <id> | kill <id>>",
    examples: ["prom agents list"],
  },
  diagram: {
    synopsis: "prom diagram <uml | deps> [path] [--out FILE]",
    examples: ["prom diagram deps ./src", "prom diagram uml file.py --out d.mmd"],
  },
  refactor: {
    synopsis: "prom refactor <structure | imports | callgraph> <file>",
    examples: ["prom refactor structure app.py"],
  },
  test: {
    synopsis:
      "prom test <discover | run | coverage | watch> [path] [--junit <file>] [--github-annotations] [--retry-failed <n>] [--tolerate-flaky]",
    examples: [
      "prom test discover",
      "prom test run tests/ --junit report.xml",
      "prom test run --retry-failed 3",
      "prom test watch python/sidecar",
    ],
  },
  health: { synopsis: "prom health [--json]", examples: ["prom health"] },
  plugin: {
    synopsis: "prom plugin <list | info | install | uninstall | enable | disable | sync | ...>",
    examples: ["prom plugin list"],
  },
  skill: { synopsis: "prom skill <list | enable | disable | mute>", examples: ["prom skill list"] },
  app: {
    synopsis: "prom app <list | install | uninstall | update | enable | disable | status | ...>",
    examples: ["prom app list"],
  },
  session: {
    synopsis: "prom session [--tmux [N]]   (the interactive single-window session)",
    examples: ["prom session"],
  },
  repl: {
    synopsis: "prom repl   (the interactive REPL/agent — bare `prom`)",
    examples: ["prom repl"],
  },
  tui: { synopsis: "prom tui   (the full-screen Ink TUI — bare `prom`)", examples: ["prom tui"] },
  version: { synopsis: "prom version   (print the CLI version)", examples: ["prom version"] },
};

function argPlaceholder(a: ArgSpec): string {
  if (a.kind === "positional") return a.required ? `<${a.name}>` : `[${a.name}]`;
  return a.type === "boolean" ? `[--${a.name}]` : `[--${a.name} <${a.type}>]`;
}

/** Synthesize a synopsis from a spec's id + argsSchema when no explicit `spec.help.synopsis`. */
function synthSynopsis(spec: CommandSpec): string {
  const parts = [`prom ${spec.id}`];
  for (const p of spec.argsSchema.positionals ?? []) parts.push(argPlaceholder(p));
  for (const f of spec.argsSchema.flags ?? []) parts.push(argPlaceholder(f));
  return parts.join(" ");
}

/** Render one command's help: synopsis + description + args table + examples (always non-empty). */
export function renderCommandHelp(spec: CommandSpec): string {
  const lines: string[] = [`${c.bold(spec.id)} — ${spec.title}`, ""];
  lines.push(c.bold("SYNOPSIS"));
  lines.push(`  ${spec.help?.synopsis ?? synthSynopsis(spec)}`);
  lines.push("");
  lines.push(spec.description);
  const positionals = spec.argsSchema.positionals ?? [];
  const flags = spec.argsSchema.flags ?? [];
  if (positionals.length > 0 || flags.length > 0) {
    lines.push("", c.bold("ARGS"));
    for (const p of positionals) {
      lines.push(
        `  ${c.cyan(`<${p.name}>`)}  ${p.description ?? p.type}${p.required ? " (required)" : ""}`,
      );
    }
    for (const f of flags) {
      const val = f.type === "boolean" ? "" : ` <${f.type}>`;
      const choices = f.choices ? ` (${f.choices.join("|")})` : "";
      lines.push(`  ${c.cyan(`--${f.name}${val}`)}  ${f.description ?? ""}${choices}`);
    }
  }
  const examples = spec.help?.examples ?? [`prom ${spec.id}`]; // always ≥1 example
  lines.push("", c.bold("EXAMPLES"));
  for (const ex of examples) lines.push(`  ${c.dim(ex)}`);
  return lines.join("\n");
}

function renderNativeHelp(topic: string, h: (typeof CLI_NATIVE_HELP)[string]): string {
  const lines = [
    `${c.bold(topic)} — prom ${topic}`,
    "",
    c.bold("SYNOPSIS"),
    `  ${h.synopsis}`,
    "",
    c.bold("EXAMPLES"),
  ];
  for (const ex of h.examples) lines.push(`  ${c.dim(ex)}`);
  return lines.join("\n");
}

/** Every help topic name (CLI-surfaced spec ids + native verbs), for the unknown-topic suggester. */
function allHelpTopics(): string[] {
  return [...listCommandSpecs("CLI").map((s) => s.id), ...Object.keys(CLI_NATIVE_HELP)];
}

/**
 * Render help for a single topic — a spec id or a native verb (a leading `/` is stripped so
 * `help /updates` === `help updates`). Unknown → exit 2 with the nearest topic suggested (CLI-049).
 */
export function helpForTopic(ctx: CliContext, rawTopic: string): CommandOutcome {
  const topic = rawTopic.replace(/^\//, "");
  const spec = getCommandSpec(topic);
  if (spec) {
    return {
      text: renderCommandHelp(spec),
      json: {
        ok: true,
        id: spec.id,
        synopsis: spec.help?.synopsis ?? synthSynopsis(spec),
        examples: spec.help?.examples ?? [`prom ${spec.id}`],
      },
      exitCode: 0,
    };
  }
  const native = CLI_NATIVE_HELP[topic];
  if (native) {
    return {
      text: renderNativeHelp(topic, native),
      json: { ok: true, id: topic, synopsis: native.synopsis, examples: native.examples },
      exitCode: 0,
    };
  }
  const near = cliProfiles.nearestKey(topic, allHelpTopics());
  return {
    text: `${c.red(`unknown help topic: ${rawTopic}`)}${near ? `\n${c.dim(`did you mean "${near}"?`)}` : ""}`,
    json: {
      ok: false,
      error: "unknown-topic",
      topic: rawTopic,
      ...(near ? { suggestion: near } : {}),
    },
    exitCode: 2,
  };
}

// Built lazily (a function, not a const) so color state set in bin.ts AFTER
// module import is respected — a top-level const would freeze color too early.
const usage =
  (): string => `${c.bold("prom")} — Prometheus Studio CLI (over @prometheus/engine-bridge)

${c.bold("USAGE")}
  prom [--json] [--no-color] <command> [args]
  prom                  (no args) → the interactive single-window session

${c.bold("INTERACTIVE SESSION")}
  ${c.cyan("prom")}                 Unified session in ONE window: chat + agent loop + panes
                       (catalog/models/env/security/health), slash + /help
  ${c.cyan("session")} [--tmux [N]]  Span MANY tmux windows when enabled (--tmux / PROMETHEUS_TMUX=1);
                       single-window fallback when tmux is absent or disabled
  ${c.cyan("chat")} --cli <svc>      Terminal chat: PREVIEW the injection-safe launch, then
       [--open|--tmux]   --open a live terminal · --tmux to multiplex (--bypass = typed-confirm)
  ${c.cyan("/setup")}               (in-session) pick + download a free local model (Ollama),
                       or connect a paid CLI — auto-shown on first run if no model
  ${c.cyan("/paths")}               (in-session) view/repoint heavy-download folders (models,
                       videos, files) under ~/.prometheus — Tab-completing folder picker

${c.bold("INVENTORY & CATALOG")}
  ${c.cyan("scan")}                 Detect installed AI agents / CLIs / IDEs
  ${c.cyan("superscan")}            Deep census: installed / absent / forgotten + prereqs
  ${c.cyan("matrix")}               Reach matrix — which plugin reaches which agent
  ${c.cyan("list")} · ${c.cyan("info")} <n>     The installable catalog · details for one plugin
  ${c.cyan("describe")}/${c.cyan("tutorial")}/${c.cyan("methods")} <id>   Rich card · dossier · install methods
  ${c.cyan("install")}/${c.cyan("uninstall")} <name>   [--only --skip --host --arm] (nemesis-gated)
  ${c.cyan("enable")}/${c.cyan("disable")} <name>      [--component hooks|mcp --host]
  ${c.cyan("plugin")}/${c.cyan("skill")}/${c.cyan("app")}/${c.cyan("worldsim")} <action>   the §2 lifecycle trees

${c.bold("SECURITY")}
  ${c.cyan("gate")} <target>        Gate a path / git-url / owner-repo via nemesis (C4)
  ${c.cyan("secure scan")} <t>      Same gate, under the secure tree
  ${c.cyan("secure db")} [status|update]      Threat-DB feed/cache status · refresh
  ${c.cyan("secure trust")} [list|log|verify <f>|revoke <n>]   trust ledger + audit log
  ${c.cyan("secure disinfect")} <t> --out D   ·  ${c.cyan("secure quarantine")} [list|restore <id>]
  ${c.cyan("harden")}               Defensive THIS-machine posture audit + fixes
  ${c.cyan("audit")} <name>         Deep-scan an installed plugin's artifacts

${c.bold("ENVIRONMENTS · MODELS · REPOS · PRIVACY")}
  ${c.cyan("env")} <list|create|clone|delete|use|export|import|doctor|add|remove|...>
  ${c.cyan("model")} <hw|list|search|browse|info|card|fit|pull|remove|serve|stop|endpoints|repoint>
  ${c.cyan("models")} <…> --set-root DIR    Local model-running tools (AirLLM/FA/…)
  ${c.cyan("repo")} <add|list|status|update|pin|branch|rescan|remove|vault>
  ${c.cyan("metadata")} <inspect|scrub|edit|timestomp> <file>   file-metadata privacy
  ${c.cyan("provider list")}        Inference providers (Tier-A free/local first)

${c.dim("Mutating verbs PREVIEW first; re-run with")} ${c.bold("--yes")} ${c.dim("to execute (--force overrides a BLOCK).")}

${c.bold("SYSTEM")}
  ${c.cyan("doctor")} [--bridge]     Health: OS/agents/git/paths (· engine discovery)
  ${c.cyan("health")}               Engine/scanner runtime posture (banded score + components)
  ${c.cyan("tokens")} [--paid|all|nano]   Token-saving toolkit (terse/caching/repo-map/RAG …) + Gemini Nano
  ${c.cyan("keymap")} list [--preset N]   Keymap presets + conflict report
  ${c.cyan("test")} <discover|run|watch> [path]   Discover + run tests; watch re-runs affected tests on save
  ${c.cyan("diagram")} <uml|deps> [path]   UML / dependency diagram (mermaid) — stdout or --out FILE
  ${c.cyan("refactor")} <structure|imports|callgraph> <file>   Read-only AST analysis of a file
  ${c.cyan("sessions")} <list|search|fork|delete>   Browse / search / fork / delete past sessions
  ${c.cyan("pentest")} <action>      ROE-gated, airgapped pentest sandbox
  ${c.cyan("version")} · ${c.cyan("help")}      Print the version · show this help

${c.bold("CONFIG · PROFILES · SESSIONS")}
  ${c.cyan("profile")} <list|use|new|edit>   ${c.cyan("config")} <get|set|list|path>   ${c.cyan("updates")} [--json]
  ${c.cyan("schedule")} <…>          Scheduled cloud agents (cron)   ${c.cyan("inventory")}   Installed-agent census
  ${c.cyan("mcp")} <list|add|remove|test>    ${c.cyan("agents")} <list|attach|kill>   ${c.cyan("localai")} <audit|list|models|…>

${c.bold("GLOBAL FLAGS")}
  --json               Emit one machine JSON object instead of pretty output
  --no-color           Disable ANSI color
  -h, --help           Show help
  -v, --version        Show version

${c.dim("Security verdicts come from the engine/nemesis — the CLI only renders them.")}`;

export function runHelp(ctx: CliContext): CommandOutcome {
  // `prom help <topic>` → per-command help (CLI-049); bare `prom help` → the global screen below.
  const topic = ctx.args.positionals[0];
  if (topic) return helpForTopic(ctx, topic);
  if (ctx.json) {
    return {
      json: {
        ok: true,
        name: "prom",
        version: PROM_VERSION,
        // CLI-050: generated from the leaf route-table (the SAME source the router's RECOGNIZED
        // set derives from) — the hand-typed list is gone, so help can never drift from routing.
        commands: [...ROUTED_VERBS],
      },
      exitCode: 0,
    };
  }
  return { text: usage(), exitCode: 0 };
}

export async function runVersion(ctx: CliContext): Promise<CommandOutcome> {
  // CLI-086: also report the detected ENGINE version — honest null/"unknown" when the engine is
  // missing/unparseable (detectEngineVersion NEVER throws; it's the raw `--version` spawn, not the
  // --json envelope path). The CLI-version part always exits 0 regardless of the engine.
  let engine: string | null = null;
  try {
    engine = (await ctx.client.version()).scriptVersion; // the client's own detectEngineVersion probe
  } catch {
    engine = null;
  }
  if (ctx.json) {
    return { json: { ok: true, name: "prom", version: PROM_VERSION, engine }, exitCode: 0 };
  }
  return { text: `prom ${PROM_VERSION} (engine ${engine ?? "unknown"})`, exitCode: 0 };
}
