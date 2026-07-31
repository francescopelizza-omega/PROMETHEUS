/**
 * orchestration/preamble.ts — the hidden cooperation PREAMBLE (pure).
 *
 * Injected ONCE into each agent's interactive session at start (typed into its tmux
 * window, invisible in the user's GUI). It turns a normal CLI session into a cooperating
 * swarm member: it states the agent's role + the team roster, FORCES cooperation, and
 * teaches the EXTERNAL-comms protocol — a shell helper `prom-msg <to> "<text>"` the agent
 * runs to message a peer / the orchestrator / everyone, which lands in the Prometheus
 * relay's RAM (never the CLI's stdout). Model-agnostic (claude/codex/gemini interactive).
 */
export interface RosterEntry {
  name: string;
  role: string;
}

export interface PreambleCtx {
  /** this agent's name. */
  self: string;
  /** this agent's specialty. */
  role: string;
  /** the orchestrator's name. */
  orchestrator: string;
  /** is this agent the orchestrator? */
  isOrchestrator: boolean;
  /** the teammates this agent may address (name + role). */
  roster: RosterEntry[];
  /** the user's goal — only for the orchestrator's opening turn. */
  goal?: string;
  /** the messaging helper command (default "prom-msg"). */
  helper?: string;
}

/** Build the preamble text to inject into an agent's session. */
export function buildPreamble(ctx: PreambleCtx): string {
  const msg = ctx.helper ?? "prom-msg";
  const peers = ctx.roster.filter((r) => r.name !== ctx.self);
  const rosterLines = peers.map((r) => `  - ${r.name} (${r.role})`).join("\n");

  const protocol = [
    "TEAM COMMUNICATION — you talk to teammates ONLY by running this shell command:",
    `  ${msg} <name> "<your message>"      send a message to a teammate (by name)`,
    `  ${msg} ${ctx.isOrchestrator ? "all" : ctx.orchestrator} "<text>"   ${ctx.isOrchestrator ? "broadcast to everyone" : "report to the orchestrator"}`,
    `  ${msg} done "<final result>"        announce you have finished your task`,
    "Run it as a normal shell/bash command. Do NOT just write the message as text — RUN the command,",
    "or no teammate will receive it. Messages from teammates arrive in your input prefixed  [from <name>] .",
  ].join("\n");

  if (ctx.isOrchestrator) {
    return [
      `You are "${ctx.self}", the ORCHESTRATOR of a cooperating AI agent team. Do NOT try to do`,
      "everything yourself — your job is to PLAN, DELEGATE, and INTEGRATE. Your team:",
      rosterLines || "  (no teammates configured — you may work solo)",
      "",
      protocol,
      "",
      "How to work:",
      "  1. Break the user's goal into subtasks matched to each teammate's specialty.",
      `  2. Delegate each: ${msg} <name> "<clear subtask + context>".`,
      "  3. As teammates report back (you'll see [from <name>] messages), integrate their work.",
      `  4. When the whole goal is complete, run: ${msg} done "<the final integrated result>".`,
      ctx.goal ? `\nThe user's goal:\n${ctx.goal}` : "",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  return [
    `You are "${ctx.self}", the ${ctx.role} specialist on a cooperating AI agent team.`,
    `The orchestrator is "${ctx.orchestrator}". Your teammates:`,
    rosterLines || "  (no other teammates)",
    "",
    protocol,
    "",
    "How to work:",
    "  - Do the subtasks the orchestrator (or a teammate) sends you, in your area of expertise.",
    `  - If you need something from a teammate, ask them: ${msg} <name> "<request>".`,
    `  - When your assigned task is done, report it: ${msg} ${ctx.orchestrator} "<your result>".`,
    "  - Otherwise wait for the next message; act when one arrives.",
  ].join("\n");
}
