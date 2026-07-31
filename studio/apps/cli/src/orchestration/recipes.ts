/**
 * orchestration/recipes.ts — per-CLI HEADLESS invocation recipes (VERIFIED).
 *
 * To use a vendor AI CLI as a subagent we invoke it NON-interactively: one prompt in,
 * the final reply on stdout, exit. Each CLI spells that differently; these recipes were
 * verified against the real CLIs (flags, mandatory guards, known hang bugs). The prompt
 * is ALWAYS a discrete argv element (no shell), so prompt content can't inject commands.
 *
 * Hang guards are LOAD-BEARING: cursor-agent `-p` and kilo hang after output in
 * feature-rich shells → every CLI call MUST be wrapped in a hard timeout (the backend
 * enforces `timeoutMs`); cursor must use `--output-format text --trust`.
 */

export interface CliRecipe {
  /** the service id (matches a topology BackendRef.service). */
  service: string;
  /** the primary binary; `binFallbacks` are tried in order if it isn't on PATH. */
  bin: string;
  binFallbacks?: readonly string[];
  /** build the argv (after `bin`) for a one-shot prompt. `model` is the optional model id. */
  buildArgs: (prompt: string, model?: string) => string[];
  /** how the prompt reaches the CLI: an argv element, or piped on stdin. */
  promptVia: "arg" | "stdin";
  /** an argv to probe auth (exit 0 / matching stdout ⇒ logged in); empty = file-based. */
  authProbe?: readonly string[];
  /** recommended hard timeout (ms) — CLIs with known post-output hangs need this. */
  timeoutMs: number;
  /** a human note (auth assumption / caveats), surfaced in the wizard. */
  note: string;
}

const MIN = 60_000;

/**
 * The shipped recipes (verified). Each yields "one prompt → final text on stdout, no
 * TTY, no confirmation prompts". The user must have logged the CLI in already — each
 * vendor CLI owns its own auth/billing; Prometheus holds no key.
 */
export const CLI_RECIPES: Readonly<Record<string, CliRecipe>> = Object.freeze({
  claude: {
    service: "claude",
    bin: "claude",
    buildArgs: (p) => ["-p", p, "--output-format", "text"],
    promptVia: "arg",
    authProbe: ["auth", "status"],
    timeoutMs: 10 * MIN,
    note: "Claude Code print mode (-p). Auth: prior `claude` login (Keychain) or CLAUDE_CODE_OAUTH_TOKEN. /login is inert in -p.",
  },
  codex: {
    service: "codex",
    bin: "codex",
    // exec is a SUBCOMMAND; --skip-git-repo-check is MANDATORY for non-git CWDs; final reply → stdout.
    buildArgs: (p) => ["exec", "--skip-git-repo-check", p],
    promptVia: "arg",
    authProbe: ["login", "status"],
    timeoutMs: 10 * MIN,
    note: "OpenAI Codex CLI `codex exec`. Auth: $CODEX_HOME/auth.json (`codex login`). progress→stderr, reply→stdout.",
  },
  gemini: {
    service: "gemini",
    bin: "gemini",
    buildArgs: (p) => ["-p", p],
    promptVia: "arg",
    timeoutMs: 10 * MIN,
    note: "Gemini CLI prompt mode (-p, auto-headless when piped). Auth: ~/.gemini/oauth_creds.json or GEMINI_API_KEY.",
  },
  cursor: {
    service: "cursor",
    bin: "cursor-agent",
    binFallbacks: ["cursor"],
    // `-p` HANGS in rich shells → text format + --trust + the backend's hard timeout are required.
    buildArgs: (p) => ["-p", p, "--output-format", "text", "--trust"],
    promptVia: "arg",
    authProbe: ["status"],
    timeoutMs: 5 * MIN,
    note: "Cursor agent print mode (cursor-agent -p). Auth: CURSOR_API_KEY / ~/.cursor. WARNING: do NOT run cursor agents in parallel (stagger them).",
  },
  aider: {
    service: "aider",
    bin: "aider",
    buildArgs: (p, model) => [
      "--message",
      p,
      "--yes-always",
      "--no-stream",
      "--no-pretty",
      "--no-check-update",
      "--no-analytics",
      ...(model ? ["--model", model] : []),
    ],
    promptVia: "arg",
    timeoutMs: 10 * MIN,
    note: "aider one-shot --message (all --no-* + --yes-always; raw stdout, no JSON). Auth: a provider API key in env.",
  },
  opencode: {
    service: "opencode",
    bin: "opencode",
    // flags MUST precede the message; prompt is the FINAL positional.
    buildArgs: (p, model) => ["run", ...(model ? ["-m", model] : []), p],
    promptVia: "arg",
    timeoutMs: 10 * MIN,
    note: "opencode run (non-interactive, auto-approves). Auth: opencode auth.json. Do NOT set provider key env (it overrides the login).",
  },
  hermes: {
    service: "hermes",
    bin: "hermes",
    // hermes -z is the cleanest one-shot in the fleet: prompt in, final reply on stdout.
    buildArgs: (p) => ["-z", p],
    promptVia: "arg",
    authProbe: ["auth", "status"],
    timeoutMs: 10 * MIN,
    note: "Nous Research Hermes agent CLI (`hermes -z`). Auth: HERMES_HOME/auth.json (`hermes auth add`).",
  },
  cline: {
    service: "cline",
    bin: "cline",
    // -y/--yolo is REQUIRED for unattended tool-touching runs (skips approvals).
    buildArgs: (p) => ["--yolo", p],
    promptVia: "arg",
    timeoutMs: 10 * MIN,
    note: "Cline CLI one-shot (`cline --yolo`). Auth: secrets.json in CLINE_DATA_DIR.",
  },
  kilocode: {
    service: "kilocode",
    bin: "kilo",
    binFallbacks: ["kilocode"],
    // known bug: fails to exit after tasks → the backend timeout is mandatory.
    buildArgs: (p) => ["run", p],
    promptVia: "arg",
    timeoutMs: 5 * MIN,
    note: "Kilocode (`kilo run`, opencode fork). Auth: kilo/auth.json (`kilo console login`). Has a no-exit bug → timeout-guarded.",
  },
});

/** The services we have a recipe for. */
export const RECIPE_SERVICES: readonly string[] = Object.freeze(Object.keys(CLI_RECIPES));

/* ── requirements metadata (CLI-071) ──────────────────────────────────────────── */

/** How a backend authenticates: an env API key, a CLI login (file-based), or none. */
export type AuthMode = "env-key" | "cli-login" | "none";

/** Static, OFFLINE requirements for a recipe — surfaced by `/demos recipes` + the preflight. */
export interface RecipeRequirement {
  /** the binary to find on PATH (mirrors the recipe's `bin`; never a divergent copy). */
  bin: string;
  authMode: AuthMode;
  /** the env var an env-key backend reads (named in the "no key" remedy). */
  envVar?: string;
  /** the one-line install command shown when the binary is missing. */
  install: string;
  /** the one-line login command shown when installed-but-not-authed (cli-login mode). */
  login?: string;
  /** mandatory guard flags already baked into the recipe argv (hang/approval guards). */
  guards: readonly string[];
}

/** Sibling to CLI_RECIPES (NOT a mutation of the frozen recipes). `bin` is derived from the recipe. */
export const RECIPE_REQUIREMENTS: Readonly<Record<string, RecipeRequirement>> = Object.freeze({
  claude: {
    bin: "claude",
    authMode: "cli-login",
    envVar: "CLAUDE_CODE_OAUTH_TOKEN",
    install: "npm i -g @anthropic-ai/claude-code",
    login: "claude login",
    guards: ["--output-format text"],
  },
  codex: {
    bin: "codex",
    authMode: "cli-login",
    install: "npm i -g @openai/codex",
    login: "codex login",
    guards: ["exec", "--skip-git-repo-check"],
  },
  gemini: {
    bin: "gemini",
    authMode: "cli-login",
    envVar: "GEMINI_API_KEY",
    install: "npm i -g @google/gemini-cli",
    login: "gemini (interactive OAuth) or set GEMINI_API_KEY",
    guards: [],
  },
  cursor: {
    bin: "cursor-agent",
    authMode: "env-key",
    envVar: "CURSOR_API_KEY",
    install: "curl https://cursor.com/install -fsS | bash",
    login: "set CURSOR_API_KEY or cursor-agent login",
    guards: ["--output-format text", "--trust"],
  },
  aider: {
    bin: "aider",
    authMode: "env-key",
    envVar: "OPENAI_API_KEY",
    install: "python -m pip install aider-install && aider-install",
    guards: ["--yes-always", "--no-stream"],
  },
  opencode: {
    bin: "opencode",
    authMode: "cli-login",
    install: "npm i -g opencode-ai",
    login: "opencode auth login",
    guards: ["run"],
  },
  hermes: {
    bin: "hermes",
    authMode: "cli-login",
    install: "see Nous Research Hermes CLI docs",
    login: "hermes auth add",
    guards: [],
  },
  cline: {
    bin: "cline",
    authMode: "cli-login",
    install: "npm i -g cline",
    login: "cline auth",
    guards: ["--yolo"],
  },
  kilocode: {
    bin: "kilo",
    authMode: "cli-login",
    install: "npm i -g kilocode",
    login: "kilo console login",
    guards: ["run"],
  },
});

/** Requirements for a service id (case-insensitive), or undefined if unknown. */
export function requirementsFor(service: string): RecipeRequirement | undefined {
  return RECIPE_REQUIREMENTS[service.toLowerCase()] ?? RECIPE_REQUIREMENTS[service];
}

/** Look up a recipe by service id (case-insensitive), honoring an override map. */
export function recipeFor(
  service: string,
  recipes: Readonly<Record<string, CliRecipe>> = CLI_RECIPES,
): CliRecipe | undefined {
  return recipes[service.toLowerCase()] ?? recipes[service];
}

export interface CliLaunch {
  bin: string;
  binFallbacks: readonly string[];
  args: string[];
  stdin?: string;
  timeoutMs: number;
}

/**
 * The launch (bin, args, optional stdin, timeout) for a service + prompt; null if
 * unknown. `recipes` may override/extend the shipped set (custom CLIs + tests). This is
 * the EXACT standalone invocation — Prometheus runs the vendor CLI as the user would,
 * never patching it.
 */
export function launchFor(
  service: string,
  prompt: string,
  model?: string,
  recipes: Readonly<Record<string, CliRecipe>> = CLI_RECIPES,
): CliLaunch | null {
  const r = recipeFor(service, recipes);
  if (!r) return null;
  const args = r.buildArgs(prompt, model);
  return {
    bin: r.bin,
    binFallbacks: r.binFallbacks ?? [],
    args,
    timeoutMs: r.timeoutMs,
    ...(r.promptVia === "stdin" ? { stdin: prompt } : {}),
  };
}
