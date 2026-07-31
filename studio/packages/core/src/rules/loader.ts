/**
 * rules/loader.ts — AGENTS.md / CLAUDE.md precedence chain + /init (file 14 §3.3).
 *
 * Ingest project + global rule files, assemble them by a precedence chain (local
 * AGENTS.md → local CLAUDE.md → global AGENTS.md → global CLAUDE.md), and inject the
 * result as system context into the agent loop. PURE: the caller READS the files and
 * passes their contents in; this assembles + scaffolds. A remote-URL `instructions`
 * source must GATE the fetch (C12) before ingestion — `isRemoteInstruction` flags it;
 * this never fetches. We are Claude Code's sibling, so CLAUDE.md is a first-class fallback.
 */

/** Where a rule file came from + which kind it is (drives precedence). */
export type RuleScope = "project" | "global";
export type RuleKind = "agents" | "claude";

/** One loaded rule source (content provided by the caller — no IO here). */
export interface RuleSource {
  scope: RuleScope;
  kind: RuleKind;
  path: string;
  content: string;
}

/**
 * The precedence chain (§3.3): earlier = higher priority (prepended first). Default:
 * local AGENTS.md → local CLAUDE.md → global AGENTS.md → global CLAUDE.md.
 */
export const DEFAULT_PRECEDENCE: ReadonlyArray<{ scope: RuleScope; kind: RuleKind }> = [
  { scope: "project", kind: "agents" },
  { scope: "project", kind: "claude" },
  { scope: "global", kind: "agents" },
  { scope: "global", kind: "claude" },
];

/** The assembled rule context fed to the agent loop. */
export interface AssembledRules {
  /** the concatenated system-context text (in precedence order). */
  text: string;
  /** the ordered source paths that contributed (provenance). */
  order: string[];
}

/** Order rule sources by the precedence chain (unknown combos drop to the end, stable). */
export function orderRuleSources(
  sources: readonly RuleSource[],
  precedence: ReadonlyArray<{ scope: RuleScope; kind: RuleKind }> = DEFAULT_PRECEDENCE,
): RuleSource[] {
  const rank = (s: RuleSource): number => {
    const i = precedence.findIndex((p) => p.scope === s.scope && p.kind === s.kind);
    return i === -1 ? precedence.length : i;
  };
  return [...sources].sort((a, b) => rank(a) - rank(b));
}

/** Assemble rule sources into one system-context block (§3.3). Empty sources are skipped. */
export function assembleRules(
  sources: readonly RuleSource[],
  precedence?: ReadonlyArray<{ scope: RuleScope; kind: RuleKind }>,
): AssembledRules {
  const ordered = orderRuleSources(
    sources.filter((s) => s.content.trim() !== ""),
    precedence,
  );
  const text = ordered
    .map((s) => `# Rules from ${s.path} (${s.scope} ${s.kind})\n\n${s.content.trim()}`)
    .join("\n\n---\n\n");
  return { text, order: ordered.map((s) => s.path) };
}

/** Whether an `instructions` source is a remote URL (the fetch MUST be gated, C12). */
export function isRemoteInstruction(source: string): boolean {
  return /^https?:\/\//i.test(source.trim());
}

/* ── /init scaffold (§3.3) ─────────────────────────────────────────────────── */

export interface InitScaffoldInput {
  projectName: string;
  /** detected/declared commands (the /init analysis pass fills these). */
  buildCmd?: string;
  testCmd?: string;
  lintCmd?: string;
  /** a one-paragraph architecture summary the analysis pass produced. */
  architecture?: string;
}

/**
 * Build the AGENTS.md scaffold `/init` writes (reject-before-write via ChangeSet, 07
 * §7.4). Pure: returns the markdown; the caller does the gated write.
 */
export function initRulesScaffold(input: InitScaffoldInput): string {
  const lines = [
    `# ${input.projectName} — Agent Rules`,
    "",
    "Project rules for AI agents (AGENTS.md). Keep this concise + current.",
    "",
    "## Commands",
    "",
    `- Build: \`${input.buildCmd ?? "<add build command>"}\``,
    `- Test:  \`${input.testCmd ?? "<add test command>"}\``,
    `- Lint:  \`${input.lintCmd ?? "<add lint command>"}\``,
    "",
    "## Architecture",
    "",
    input.architecture?.trim()
      ? input.architecture.trim()
      : "<one paragraph: layout, entry points, key modules>",
    "",
    "## Conventions",
    "",
    "- Match the surrounding code's style.",
    "- Every code-fetch/exec/install crosses the nemesis gate; never pass --force.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}
