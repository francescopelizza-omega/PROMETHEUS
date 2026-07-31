/**
 * commands.ts — typed argv builders for prometheus.py subcommands.
 *
 * CONTRACT (C2): GLOBAL FLAGS come BEFORE the subcommand. The run layer always
 * prepends `--json --no-color`, so these builders return the command line that
 * follows those, i.e. [...globalFlags, subcommand, ...positionals/flags].
 *
 * Ported faithfully from prometheus_plugin/mcp-server/src/tools.ts (toArgv).
 * shell:false at the spawn site means names are passed verbatim — no quoting.
 */

export interface InstallFlags {
  only?: string;
  dryRun?: boolean;
  yes?: boolean;
  strict?: boolean;
  /** maps to --force: override a nemesis BLOCK (forced_danger). */
  forced?: boolean;
}

export interface UninstallFlags {
  only?: string;
  dryRun?: boolean;
  yes?: boolean;
}

export interface ToggleFlags {
  /** toggle on-disk hooks or MCP servers rather than the whole plugin */
  component?: "hooks" | "mcp";
}

/** Options for a terminal-chat PREVIEW (chat --cli ...; never --open here). */
export interface ChatPreviewOpts {
  model?: string;
  /** path to a system-prompt file (appended unless replaceSystem). */
  systemPrompt?: string;
  replaceSystem?: boolean;
  bypass?: boolean;
  /** true = --tmux (default session name); string = --tmux NAME; omit = no tmux. */
  tmux?: string | boolean;
  cwd?: string;
  /** one-shot prompt (else interactive). */
  prompt?: string;
}

/**
 * Option-injection guard for identifier-shaped args (catalog ids, plugin names,
 * model ids, --only/--set-root values). These are NEVER legitimately dash-leading, so
 * a value starting with `-` is either a mistake or an attempt to smuggle a flag into
 * the engine's argparse — reject it loudly. (Free-form prompts use a `--` separator
 * instead; see chatLocal/chatPreview.)
 */
export function notFlag(value: string, what: string): string {
  if (value.startsWith("-")) {
    throw new Error(`refusing ${what} that starts with '-' (option-injection guard): ${value}`);
  }
  return value;
}

const Commands = {
  // ---- read-only inventory / query --------------------------------------- //
  scan: (): string[] => ["scan"],
  superscan: (): string[] => ["superscan"],
  list: (): string[] => ["list"],
  matrix: (): string[] => ["matrix"],
  info: (name: string): string[] => ["info", notFlag(name, "name")],
  where: (name: string): string[] => ["where", notFlag(name, "name")],
  status: (name: string): string[] => ["status", notFlag(name, "name")],
  /** registry plugin NAME only — never a --target (C4). */
  audit: (name: string): string[] => ["audit", notFlag(name, "name")],
  vaultStatus: (): string[] => ["vault"],

  // ---- catalog cards (describe / tutorial / methods) --------------------- //
  describe: (id: string): string[] => ["describe", notFlag(id, "id")],
  tutorial: (id: string): string[] => ["tutorial", notFlag(id, "id")],
  methods: (id: string): string[] => ["methods", notFlag(id, "id")],

  // ---- defensive self-audit --------------------------------------------- //
  harden: (): string[] => ["harden"],

  // ---- local models (config / browse / pull) ---------------------------- //
  modelsConfig: (setRoot?: string): string[] =>
    setRoot
      ? ["models", "config", "--set-root", notFlag(setRoot, "--set-root path")]
      : ["models", "config", "--show"],
  modelsBrowse: (): string[] => ["models", "browse"],
  modelsPull: (model: string): string[] => ["models", "pull", notFlag(model, "model")],

  // ---- chat (agentic local / terminal preview) -------------------------- //
  // The trailing free-form prompt may legitimately start with `-`; a `--`
  // end-of-options separator forces argparse to treat it as the `message`
  // positional (data) rather than an injected flag.
  chatLocal: (model: string, prompt?: string, runner?: string): string[] => [
    "chat",
    "--local",
    model,
    ...(runner ? ["--runner", runner] : []),
    ...(prompt ? ["--", prompt] : []),
  ],
  /** Terminal-chat PREVIEW argv (no --open — the engine returns the assembled argv). */
  chatPreview: (cli: string, o: ChatPreviewOpts = {}): string[] => [
    "chat",
    "--cli",
    cli,
    ...(o.model ? ["--model", o.model] : []),
    ...(o.systemPrompt ? ["--system-prompt", o.systemPrompt] : []),
    ...(o.replaceSystem ? ["--replace-system"] : []),
    ...(o.bypass ? ["--bypass"] : []),
    ...(o.tmux === undefined ? [] : typeof o.tmux === "string" ? ["--tmux", o.tmux] : ["--tmux"]),
    ...(o.cwd ? ["--cwd", o.cwd] : []),
    ...(o.prompt ? ["--", o.prompt] : []),
  ],

  // ---- state-changing ---------------------------------------------------- //
  install: (name: string, f: InstallFlags = {}): string[] => [
    ...(f.dryRun ? ["--dry-run"] : []),
    ...(f.yes ? ["--yes"] : []),
    ...(f.strict ? ["--strict"] : []),
    ...(f.forced ? ["--force"] : []),
    "install",
    notFlag(name, "name"),
    ...(f.only ? ["--only", notFlag(f.only, "--only")] : []),
  ],

  uninstall: (name: string, f: UninstallFlags = {}): string[] => [
    ...(f.dryRun ? ["--dry-run"] : []),
    ...(f.yes ? ["--yes"] : []),
    "uninstall",
    notFlag(name, "name"),
    ...(f.only ? ["--only", notFlag(f.only, "--only")] : []),
  ],

  enable: (name: string, f: ToggleFlags = {}): string[] => [
    "enable",
    notFlag(name, "name"),
    ...(f.component ? ["--component", f.component] : []),
  ],

  disable: (name: string, f: ToggleFlags = {}): string[] => [
    "disable",
    notFlag(name, "name"),
    ...(f.component ? ["--component", f.component] : []),
  ],
} as const;

export type CommandsApi = typeof Commands;

export { Commands };
