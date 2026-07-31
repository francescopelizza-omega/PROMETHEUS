/**
 * session/faq.ts — the `/faq` knowledge base: short answers to the most frequent
 * questions, covering EVERY major Prometheus functionality (getting started, models
 * local + paid, security/gating, catalog install, environments, repos, privacy,
 * download paths, tmux/subagents, chat, troubleshooting).
 *
 * `/faq`            → list the topics.
 * `/faq <query>`    → the best-matching answer(s) (keyword scored).
 * Pure data + a tiny matcher — no engine, no I/O. Unit-tested.
 */
import { c } from "../render.js";

export interface FaqEntry {
  /** short slug shown in the topic list + matchable. */
  topic: string;
  /** the question. */
  q: string;
  /** the answer (already plain text; the renderer colors the frame). */
  a: string;
  /** extra match keywords. */
  keywords: readonly string[];
}

export const FAQ_DB: readonly FaqEntry[] = Object.freeze([
  {
    topic: "start",
    q: "How do I start using Prometheus?",
    a: "Run a bare `prom` for the interactive session, or one-shot verbs like `prom scan`. First time, if no local model is found, you'll see /setup — pick a free local model or connect a paid CLI.",
    keywords: ["begin", "getting", "first", "launch", "run", "open"],
  },
  {
    topic: "model-local",
    q: "How do I run a free local model?",
    a: "Type /setup → 'Download a free local model'. It uses Ollama (install via `prom apps install ollama`), pulls a model (e.g. qwen2.5-coder:7b), and stores it under ~/.prometheus/open_models. Once a local runner serves a model, the session auto-uses it.",
    keywords: ["ollama", "lmstudio", "offline", "free", "gguf", "download model"],
  },
  {
    topic: "model-paid",
    q: "How do I use a paid CLI (Claude/Codex/Gemini)?",
    a: "Type /setup → 'Connect a paid CLI', or run `prom chat --cli claude --open` to launch a live terminal chat with that CLI. Prometheus previews the injection-safe command first (never-force).",
    keywords: ["claude", "codex", "gemini", "cursor", "opencode", "api", "cloud", "chat"],
  },
  {
    topic: "switch-model",
    q: "How do I switch models?",
    a: "Use /model <name> in the session (e.g. /model ollama:qwen2.5-coder:7b). /tune shows the current model + gate + dry-run.",
    keywords: ["change model", "set model", "/model"],
  },
  {
    topic: "security",
    q: "What is the security gate (nemesis)?",
    a: "Every install/clone/download is scanned by nemesis and gets a verdict: allow (0) / warn (10) / block (20) / error (2, fail-closed). Prometheus NEVER decides 'safe' in JS — it renders the engine's verdict. Override a block only with --force behind a typed confirm.",
    keywords: ["nemesis", "gate", "safe", "scan", "verdict", "block", "malware"],
  },
  {
    topic: "gate-target",
    q: "How do I check if a repo/package is safe?",
    a: "Run `prom gate <path|git-url|owner/repo>` (or /secure scan <target>). It returns the nemesis verdict + findings. Fail-closed: a missing/timed-out scanner blocks.",
    keywords: ["is this safe", "check", "audit url", "vet"],
  },
  {
    topic: "harden",
    q: "How do I check my machine's security posture?",
    a: "Run `prom harden` (or /harden) — a read-only, THIS-machine-only audit of firewall / open ports / ssh / disk-encryption / secret-perms, with concrete fixes. For deeper testing see `prom pentest`.",
    keywords: ["firewall", "ports", "ssh", "posture", "defensive"],
  },
  {
    topic: "install",
    q: "How do I install a plugin or skill?",
    a: "Browse with /list or /describe <id>, then /install <name> (nemesis-gated). /skills manages installed SKILL.md folders; /sync replicates a skill across agents. Add --only/--host/--arm for subsets/targets.",
    keywords: ["plugin", "skill", "add", "marketplace", "bundle"],
  },
  {
    topic: "env",
    q: "How do I manage Python environments?",
    a: "/env list shows venv/conda/system envs. /env create <name>, /env add <env> <pkg> (pip install, gated), /env clone, /env cuda torch <env>. Mutations preview first — add --yes to execute.",
    keywords: ["venv", "conda", "python", "pip", "package", "cuda", "torch"],
  },
  {
    topic: "models-tools",
    q: "How do I discover + download open models?",
    a: "/model search <q>, /model fit (scores models vs your hardware), /model pull <id> (gated download → ~/.prometheus/open_models), /model hw (hardware budget), /model endpoints (live runners).",
    keywords: ["huggingface", "search model", "quant", "fit", "hardware", "vram"],
  },
  {
    topic: "repo",
    q: "How do I clone/manage GitHub repos safely?",
    a: "/repo add <url> stages → nemesis-gates → promotes or quarantines (the only arbitrary-URL clone path). /repo list, /repo pin <id> <sha>, /repo branch, /repo rescan, /repo vault (offline archive). Preview-first; --yes to execute.",
    keywords: ["clone", "git", "github", "vault", "pin", "branch"],
  },
  {
    topic: "privacy",
    q: "How do I strip metadata from files?",
    a: "/metadata inspect <file> reads it; /metadata scrub <file> strips all metadata (copy-then-replace, original safe); /metadata edit/timestomp for fine control. Plan-only until --yes.",
    keywords: ["metadata", "exif", "scrub", "timestomp", "anonymize"],
  },
  {
    topic: "paths",
    q: "Where does Prometheus store everything? Can I change it?",
    a: "Everything lives under ~/.prometheus (config, open_models, downloads/{videos,audio,files}, cache, logs, records, state). Run /paths to repoint heavy-download folders (models/videos/files) to another disk — Tab-completes. Override the root with $PROMETHEUS_HOME.",
    keywords: ["folder", "directory", "download path", "disk", "storage", "~/.prometheus", "home"],
  },
  {
    topic: "tmux",
    q: "What happens under tmux / how do subagents work?",
    a: "When tmux is active, Prometheus runs in orchestrator mode with 3 subagents by default; the main agent scales that up for complex prompts. /agents [n] shows/sets the count; /orchestrate <task> decomposes a big task. Roster: build · plan · explore · scout.",
    keywords: ["subagent", "orchestrator", "parallel", "team", "agents", "panes"],
  },
  {
    topic: "apps",
    q: "How do I install self-hosted apps (yt-dlp, ollama, n8n)?",
    a: "/apps list shows them; /apps install <id> [--path DIR] installs (gated). YouTube/video downloads land under ~/.prometheus/downloads/videos (change via /paths). /worldsim for agent-based simulators.",
    keywords: ["yt-dlp", "youtube", "ollama", "n8n", "penpot", "self-host", "docker"],
  },
  {
    topic: "color",
    q: "Why don't I see colors?",
    a: 'Color auto-disables when stdout isn\'t a detected TTY (or NO_COLOR / TERM=dumb is set). Force it on with FORCE_COLOR=1 (e.g. `FORCE_COLOR=1 prom`). Check yours: node -e "console.log(process.stdout.isTTY)".',
    keywords: ["colour", "ansi", "no color", "force_color", "tty"],
  },
  {
    topic: "no-model",
    q: "Chat says no model / 'ollama unreachable'. What now?",
    a: "No local runner is serving a model. Type /setup to download a free local model (Ollama), or connect a paid CLI. A paid model name (e.g. claude-opus) can't run locally — use /model ollama:<tag> for local, or `prom chat --cli claude --open`.",
    keywords: ["unreachable", "no backend", "ollama down", "model error", "server"],
  },
  {
    topic: "commands",
    q: "What commands are available?",
    a: "/commands lists every /command grouped; /help shows the top ones. Anything you can do as `prom <verb>` you can do as a /verb in-session, plus session/agent/review macros.",
    keywords: ["slash", "list commands", "help", "what can"],
  },
  {
    topic: "context",
    q: "How do I manage the conversation context?",
    a: "/compact summarizes + reclaims context (keeps project memory); /clear (or /new) starts fresh; /init writes a PROMETHEUS.md project-memory file; /memory refreshes it.",
    keywords: ["compact", "clear", "memory", "reset", "context window", "token"],
  },
  {
    topic: "trouble",
    q: "Something's broken — how do I diagnose it?",
    a: "Run /doctor (OS/agents/git/paths) or `prom doctor --bridge` (engine discovery). /status shows the session config. Most read commands are fail-closed — a clear error beats a wrong 'ok'.",
    keywords: ["broken", "error", "diagnose", "doctor", "debug", "not working"],
  },
]);

/** Score an entry against a query (topic + keywords + question text). */
function score(entry: FaqEntry, q: string): number {
  const hay = `${entry.topic} ${entry.q} ${entry.keywords.join(" ")}`.toLowerCase();
  let s = 0;
  for (const w of q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1)) {
    if (entry.topic === w) s += 5;
    else if (hay.includes(w)) s += 1;
  }
  return s;
}

/** Render `/faq` (no query → topic list) or `/faq <query>` (best matches). */
export function renderFaq(query: string): string {
  const q = query.trim();
  if (!q) {
    const lines = [`${c.bold("FAQ")} ${c.dim("— ask: /faq <topic or words>")}`, ""];
    for (const e of FAQ_DB) lines.push(`  ${c.cyan(e.topic.padEnd(14))} ${c.dim(e.q)}`);
    return lines.join("\n");
  }
  const ranked = FAQ_DB.map((e) => ({ e, s: score(e, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  if (ranked.length === 0) {
    return `${c.dim(`No FAQ match for "${q}".`)} ${c.dim("Try /faq for the topic list.")}`;
  }
  const lines: string[] = [];
  for (const { e } of ranked) {
    lines.push(`${c.bold(`Q: ${e.q}`)} ${c.dim(`[${e.topic}]`)}`);
    lines.push(`   ${e.a}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
