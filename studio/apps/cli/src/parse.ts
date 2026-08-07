/**
 * parse.ts — the hand-rolled arg parser for `prometheus`. ZERO deps.
 *
 * Splits argv into: a command path (one or two tokens, e.g. ["model","hw"]),
 * positional args, and a small set of recognised GLOBAL flags. Unknown flags are
 * captured (not thrown) so commands can inspect them, but the global ones are
 * pulled out here so every command sees a consistent { json, noColor } view.
 *
 * Grammar (kept deliberately tiny):
 *   prometheus [globals] <command> [subcommand] [positional...] [--flags]
 * Two-word commands ("model hw", "provider list", "env list") are recognised by
 * a static set; everything after the (sub)command is a positional unless it
 * starts with "-".
 */

export interface ParsedArgs {
  /** the resolved command path, e.g. ["scan"], ["model","hw"], ["provider","list"]. */
  command: string[];
  /** positional args AFTER the command path. */
  positionals: string[];
  /** --json global flag (machine output). */
  json: boolean;
  /** --no-color global flag (disable ANSI). */
  noColor: boolean;
  /** -h/--help requested (global or after a command). */
  help: boolean;
  /** -v/--version requested. */
  version: boolean;
  /** bare `prometheus` (no command, no -h/-v) → launch the interactive REPL (§1). */
  repl: boolean;
  // ── §1 engine global flags (lifted from `flags`; map 1:1 to engine flags) ──
  dryRun: boolean;
  yes: boolean;
  strict: boolean;
  force: boolean;
  noGate: boolean;
  gateMode?: "enforce" | "warn" | "off";
  profile?: string;
  engine?: string;
  python?: string;
  cwd?: string;
  verbose: boolean;
  quiet: boolean;
  /** any other flags, captured verbatim (name -> value|true). */
  flags: Record<string, string | true>;
}

/** Commands that take a subcommand token as the SECOND word of the path (§2 tree). */
const TWO_WORD: Record<string, Set<string>> = {
  model: new Set([
    "hw",
    "list",
    "ls",
    "library",
    "search",
    "browse",
    "info",
    "card",
    "fit",
    "pull",
    "remove",
    "rm",
    "prune",
    "serve",
    "stop",
    "ps",
    "status",
    "tools",
    "endpoints",
    "repoint",
  ]),
  provider: new Set(["list", "ls", "show", "connect", "status", "disconnect", "enable-metered"]),
  agents: new Set(["list", "attach", "kill"]),
  mcp: new Set(["list", "add", "remove", "test"]),
  keymap: new Set(["list"]),
  env: new Set([
    "list",
    "ls",
    "create",
    "clone",
    "use",
    "info",
    "doctor",
    "export",
    "import",
    "add",
    "remove",
    "update",
    "upgrade",
    "enable",
    "disable",
    "delete",
    "cuda",
    "init",
    "templates",
    "template",
  ]),
  secure: new Set([
    "scan",
    "audit",
    "verdict",
    "disinfect",
    "quarantine",
    "purge",
    "db",
    "trust",
    "ignore",
    "accept",
  ]),
  plugin: new Set([
    "list",
    "info",
    "where",
    "status",
    "install",
    "uninstall",
    "enable",
    "disable",
    "bundle",
    "sync",
    "scaffold-skill",
  ]),
  skill: new Set(["list", "enable", "disable", "mute"]),
  repo: new Set([
    "add",
    "clone",
    "list",
    "status",
    "rescan",
    "update",
    "pin",
    "branch",
    "remove",
    "vault",
  ]),
  metadata: new Set(["inspect", "scrub", "edit", "timestomp"]),
  app: new Set([
    "list",
    "installed",
    "install",
    "uninstall",
    "update",
    "update-all",
    "enable",
    "disable",
    "restart",
    "status",
    "logs",
    "open",
    "versions",
    "rollback",
  ]),
  worldsim: new Set([
    "list",
    "installed",
    "install",
    "uninstall",
    "update",
    "enable",
    "disable",
    "restart",
    "status",
    "logs",
    "open",
    "versions",
    "rollback",
  ]),
  pentest: new Set([
    "list",
    "scope",
    "status",
    "runtimes",
    "build",
    "install",
    "shell",
    "run",
    "destroy",
    "enable",
    "disable",
    "logs",
    "update",
  ]),
  localai: new Set(["audit", "list", "models", "endpoints", "show", "model"]),
  profile: new Set(["list", "use", "edit", "new"]),
  config: new Set(["get", "set", "path", "list"]),
  test: new Set(["discover", "run", "coverage", "watch"]),
  diagram: new Set(["uml", "deps"]),
  refactor: new Set(["structure", "imports", "callgraph"]),
  sessions: new Set(["list", "search", "fork", "delete"]),
};

/** Single-word top-level commands (§2 tree). */
const ONE_WORD = new Set([
  "scan",
  "superscan",
  "doctor",
  "health",
  "matrix",
  "inventory",
  "gate",
  "list",
  "ls",
  "info",
  "secure",
  "plugin",
  "skill",
  "env",
  "model",
  "repo",
  "metadata",
  "app",
  "worldsim",
  "pentest",
  "localai",
  "provider",
  "agents",
  "mcp",
  "chat",
  "repl",
  "tui",
  "session",
  "sessions",
  "schedule",
  "profile",
  "config",
  "keymap",
  "test",
  "diagram",
  "refactor",
  "tokens",
  "updates",
  "completion",
  "man",
  "version",
  "help",
  // single-token CommandSpec verbs (the canonical parity registry): these route
  // straight through invoke() — the SAME run() the GUI palette uses — so
  // `prometheus install foo`, `prometheus describe <id>`, `prometheus apps list`, `prometheus harden`, …
  // reach full GUI parity instead of falling through to the usage screen.
  "install",
  "uninstall",
  "enable",
  "disable",
  "bundle",
  "status",
  "audit",
  "where",
  "purge",
  "sync",
  "scaffold-skill",
  "skills",
  "describe",
  "tutorial",
  "methods",
  "harden",
  "apps",
  "models",
  "vault",
  "wizard",
]);

const isFlag = (t: string): boolean => t.startsWith("-");

/**
 * Flags that NEVER take a value — membership here stops the greedy `--key value`
 * branch from swallowing the following positional (`prometheus gate --strict ./x` used
 * to store `flags.strict = "./x"` and drop `./x`). Consulted BEFORE consumption.
 *
 * Classification audit — every flag `prometheus` consumes must pick a side:
 *   BOOLEAN (in this set): strict, yes (+alias y), dry-run, force, force-unsafe,
 *     no-gate (+ negation no-strict), verbose, quiet (+alias q), bridge, bypass,
 *     ink, paid, plain, rescan, replace-system, open, summary (diagram terse view),
 *     continue (prometheus --continue resumes the newest session, CLI-013).
 *     (json / no-color / help / version are matched EARLIER, before this branch.)
 *   VALUE-TAKING (deliberately absent, so greedy `--key value` still applies):
 *     profile, engine, python, cwd, gate-mode, only, host, preset, cli, tmux,
 *     local.
 * A boolean's explicit `--flag=value` form is still honored (the `=` branch runs
 * first) and coerced by flagBool() in liftGlobals, so `--strict=false` reads false.
 */
const BOOLEAN_FLAGS = new Set<string>([
  "strict",
  "no-strict",
  "yes",
  "y",
  "dry-run",
  "force",
  "force-unsafe",
  "no-gate",
  "verbose",
  "quiet",
  "q",
  "bridge",
  "bypass",
  "ink",
  "paid",
  "plain",
  "rescan",
  "replace-system",
  "open",
  "summary",
  "continue",
  "fits",
  "free",
  "free-only",
  "keep-unverified",
  "force-budget",
  "explain", // CLI-080: `secure <target> --explain` — boolean so it never consumes the target
]);

/**
 * Parse a raw argv slice (NOT including node + script). Pure: no I/O, no exit.
 * Throws nothing — malformed input surfaces as help:true / empty command.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: [],
    positionals: [],
    json: false,
    noColor: false,
    help: false,
    version: false,
    repl: false,
    dryRun: false,
    yes: false,
    strict: false,
    force: false,
    noGate: false,
    verbose: false,
    quiet: false,
    flags: {},
  };

  // First pass: pull global flags out of the WHOLE argv so `--json` may appear
  // anywhere (before OR after the command), matching the engine's global-flag
  // contract spirit. Non-global flags are stashed in result.flags.
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === "--") {
      // everything after "--" is positional, verbatim
      for (let j = i + 1; j < argv.length; j++) {
        const v = argv[j];
        if (v !== undefined) rest.push(v);
      }
      break;
    }
    if (tok === "--json") {
      result.json = true;
      continue;
    }
    if (tok === "--no-color" || tok === "--no-colour") {
      result.noColor = true;
      continue;
    }
    if (tok === "-h" || tok === "--help") {
      result.help = true;
      continue;
    }
    if (tok === "-v" || tok === "--version") {
      result.version = true;
      continue;
    }
    if (isFlag(tok)) {
      // generic flag: support --key=value and --key value(if next is not a flag)
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        const key = tok.slice(0, eq).replace(/^-+/, "");
        result.flags[key] = tok.slice(eq + 1);
      } else {
        const key = tok.replace(/^-+/, "");
        if (BOOLEAN_FLAGS.has(key)) {
          // known boolean: never consume the next token as its value
          result.flags[key] = true;
          continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && !isFlag(next) && !looksLikeCommandTail(rest, next)) {
          result.flags[key] = next;
          i++;
        } else {
          result.flags[key] = true;
        }
      }
      continue;
    }
    rest.push(tok);
  }

  // Lift the §1 engine globals out of the generic flag bag into typed fields, so
  // every return path (incl. help/version) carries them (e.g. `prometheus --json --profile ci`).
  liftGlobals(result);

  // Second pass: resolve the command path from the non-flag tokens.
  if (rest.length === 0) {
    // bare `prometheus` -> launch the interactive REPL (§1); -h/--version still short-circuit.
    if (!result.version && !result.help) result.repl = true;
    return result;
  }

  const first = rest[0];
  if (first === undefined) {
    result.help = true;
    return result;
  }

  if (!ONE_WORD.has(first)) {
    // unknown command — flag help so bin.ts can print usage + nonzero exit
    result.command = [first];
    result.positionals = rest.slice(1);
    result.help = true;
    return result;
  }

  // does it take a second word?
  const sub = rest[1];
  const twoWordSet = TWO_WORD[first];
  if (twoWordSet && sub !== undefined && twoWordSet.has(sub)) {
    result.command = [first, normalizeAlias(sub)];
    result.positionals = rest.slice(2);
  } else {
    result.command = [normalizeAlias(first)];
    result.positionals = rest.slice(1);
  }

  return result;
}

/** Map command aliases to their canonical spelling. */
function normalizeAlias(token: string): string {
  switch (token) {
    case "ls":
      return "list";
    default:
      return token;
  }
}

/**
 * Heuristic: don't swallow a value into a flag if it is actually the command
 * tail. We only guard the very first non-flag token (the command name) from
 * being eaten by a preceding global-ish flag. Conservative: only true when
 * nothing has been collected yet AND the token is a known command.
 */
function looksLikeCommandTail(collected: string[], next: string): boolean {
  return collected.length === 0 && ONE_WORD.has(next);
}

/** A captured flag's value as a string (true/missing → undefined). */
function flagStr(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

/** Parse an explicit boolean-flag value: only false/0/no/off/"" are falsy. */
function parseBoolStr(s: string): boolean {
  const t = s.trim().toLowerCase();
  return !(t === "false" || t === "0" || t === "no" || t === "off" || t === "");
}

/**
 * Resolve a lifted boolean global across its canonical key + aliases. A bare flag
 * is `true`; an explicit `--flag=value` is PARSED (not cast — `Boolean("false")`
 * is truthy, which is the silent-bug mechanism this file guards against).
 */
function flagBool(flags: Record<string, string | true>, ...keys: string[]): boolean {
  for (const k of keys) {
    const v = flags[k];
    if (v === true) return true;
    if (typeof v === "string") return parseBoolStr(v);
  }
  return false;
}

/**
 * Lift the §1 engine global flags from the generic `flags` bag into typed fields.
 * The flags themselves stay in `flags` too (so commands can still inspect them).
 */
function liftGlobals(result: ParsedArgs): void {
  const f = result.flags;
  result.dryRun = flagBool(f, "dry-run");
  result.yes = flagBool(f, "yes", "y");
  result.strict = flagBool(f, "strict");
  result.force = flagBool(f, "force", "force-unsafe");
  result.noGate = flagBool(f, "no-gate");
  result.verbose = flagBool(f, "verbose");
  result.quiet = flagBool(f, "quiet", "q");
  const gateMode = flagStr(f, "gate-mode");
  if (gateMode === "enforce" || gateMode === "warn" || gateMode === "off")
    result.gateMode = gateMode;
  const profile = flagStr(f, "profile");
  if (profile) result.profile = profile;
  const engine = flagStr(f, "engine");
  if (engine) result.engine = engine;
  const python = flagStr(f, "python");
  if (python) result.python = python;
  const cwd = flagStr(f, "cwd");
  if (cwd) result.cwd = cwd;
}
