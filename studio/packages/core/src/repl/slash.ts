/**
 * repl/slash.ts — the §3.1 slash-command registry + parser (PURE).
 *
 * Modeled on claude's `/`-surface. Each slash is a thin alias over the command tree
 * or an agent-tuning verb. This is the framework-free brain; the Ink view binds it.
 */

export interface SlashCommand {
  name: string;
  arg?: string;
  description: string;
  /** true if this slash mutates the live agent tuning (the §3.1 tuning verbs). */
  tuning?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: "help", description: "command palette + key list" },
  { name: "scan", description: "drop the scan pane inline" },
  { name: "superscan", description: "deep inventory pane" },
  { name: "matrix", description: "reach matrix pane" },
  { name: "doctor", description: "health pane" },
  { name: "secure", arg: "<pkg|path>", description: "run the nemesis gate, render the verdict" },
  { name: "install", arg: "<name>", description: "catalog install (gated; dry-run preview first)" },
  { name: "uninstall", arg: "<name>", description: "catalog uninstall (gated)" },
  { name: "env", description: "open the env manager pane" },
  {
    name: "model",
    arg: "[id]",
    description: "open the model pane, or switch the agent model",
    tuning: true,
  },
  { name: "repo", description: "open the repo manager pane" },
  { name: "app", description: "open the apps pane" },
  { name: "worldsim", description: "open the world-sim pane" },
  { name: "vault", description: "repo-vault status pane" },
  { name: "skills", description: "skills pane" },
  { name: "system", arg: "<text>", description: "set the agent system prompt", tuning: true },
  { name: "tools", arg: "on|off|list", description: "arm/disarm tool use", tuning: true },
  { name: "gate", arg: "enforce|warn|off", description: "set the install gate mode", tuning: true },
  {
    name: "dry-run",
    arg: "on|off",
    description: "toggle whether tools execute or preview",
    tuning: true,
  },
  { name: "verbosity", arg: "quiet|normal|debug", description: "output density", tuning: true },
  { name: "profile", arg: "<name>", description: "hot-swap the tuning profile", tuning: true },
  { name: "yes", arg: "on|off", description: "auto-approve non-critical findings", tuning: true },
  { name: "clear", description: "clear the transcript" },
  { name: "save", arg: "<file>", description: "save the transcript" },
  { name: "resume", description: "resume a saved transcript" },
  { name: "cwd", arg: "<dir>", description: "change working directory" },
  { name: "quit", description: "exit" },
]);

const BY_NAME = new Map(SLASH_COMMANDS.map((s) => [s.name, s]));

/** The §3.1 tuning verbs (mutate the live AgentTuning). */
export const TUNING_SLASHES: ReadonlySet<string> = new Set(
  SLASH_COMMANDS.filter((s) => s.tuning).map((s) => s.name),
);

export type ParsedInput =
  | { kind: "message"; text: string }
  | { kind: "slash"; name: string; rest: string };

/** Parse a REPL input line: a leading "/" makes it a slash command, else a message. */
export function parseSlash(input: string): ParsedInput {
  const t = input.trimStart();
  if (!t.startsWith("/")) return { kind: "message", text: input };
  const body = t.slice(1);
  const sp = body.indexOf(" ");
  if (sp === -1) return { kind: "slash", name: body, rest: "" };
  return { kind: "slash", name: body.slice(0, sp), rest: body.slice(sp + 1).trim() };
}

/** Is a slash name known? */
export function knownSlash(name: string): boolean {
  return BY_NAME.has(name);
}

/** Look up a slash command's metadata. */
export function getSlash(name: string): SlashCommand | undefined {
  return BY_NAME.get(name);
}
