// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
    a: "Run a bare `prometheus` for the interactive session, or one-shot verbs like `prometheus scan`. First time, if no local model is found, you'll see /setup — pick a free local model or connect a paid CLI.",
    keywords: ["begin", "getting", "first", "launch", "run", "open"],
  },
  {
    topic: "model-local",
    q: "How do I run a free local model?",
    a: "Type /setup → 'Download a free local model'. It uses Ollama (install it with `/models runtimes install ollama` — the native app, through its official package channel), pulls a model (e.g. qwen2.5-coder:7b) and scans what Ollama stored with nemesis before the model is used. Once a local runner serves a model, the session auto-uses it.",
    keywords: ["ollama", "lmstudio", "offline", "free", "gguf", "download model"],
  },
  {
    topic: "model-paid",
    q: "How do I use a paid CLI (Claude/Codex/Gemini)?",
    a: "Type /setup → 'Connect a paid CLI', or run `prometheus chat --cli claude --open` to launch a live terminal chat with that CLI. Prometheus previews the injection-safe command first (never-force).",
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
    // Precise, not blanket. Catalog installs, repo clones and the HF/GGUF model spine stage
    // bytes locally and pass them to `nemesis_gate` BEFORE admission; an Ollama pull has no
    // stage, so `v_pull` (python/sidecar/modelhub.py) scans the stored blobs AFTER the download
    // and before the model is used (gate_ollama_model). Say which is which.
    a: "Catalog installs, repo clones and staged model downloads are scanned by nemesis and get a verdict: allow (0) / warn (10) / block (20) / error (2, fail-closed). Models pulled through Ollama are scanned after the download and before they are used (removed on a block). For a model download a warning is used only when you type the model's name, and a block is final. Prometheus NEVER decides 'safe' in JS — it renders the engine's verdict. Other installs: override a block only with --force behind a typed confirm.",
    keywords: ["nemesis", "gate", "safe", "scan", "verdict", "block", "malware"],
  },
  {
    topic: "gate-target",
    q: "How do I check if a repo/package is safe?",
    a: "Run `prometheus gate <path|git-url|owner/repo>` (or /secure scan <target>). It returns the nemesis verdict + findings. Fail-closed: a missing/timed-out scanner blocks.",
    keywords: ["is this safe", "check", "audit url", "vet"],
  },
  {
    topic: "harden",
    q: "How do I check my machine's security posture?",
    a: "Run `prometheus harden` (or /harden) — a read-only, THIS-machine-only audit of firewall / open ports / ssh / disk-encryption / secret-perms, with concrete fixes. For deeper testing see `prometheus pentest`.",
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
    topic: "models-pick",
    q: "How do I choose a model (local, free cloud, paid, or the endless free rotation)?",
    a: "/models walks you through it: local (always free, fit-checked against your RAM — it installs Ollama and downloads the model for you, and says when a model only runs through colibri or AirLLM) or cloud (free quotas like NVIDIA NIM / Groq / Cerebras, paid like Claude / GPT-5 / Gemini, or the endless free rotation that moves to the next free provider when one runs out). /models use <ref> switches directly; /models current shows the rotation's state.",
    keywords: [
      "model",
      "models",
      "pick",
      "choose",
      "free",
      "nvidia",
      "nemotron",
      "kimi",
      "glm",
      "rotation",
      "airllm",
      "colibri",
      "lm studio",
    ],
  },
  {
    topic: "models-tools",
    q: "How do I discover + download open models?",
    // These are their OWN verbs. This answer used to say `/model search|fit|pull|hw|endpoints`,
    // and `/model search x` answered "no model matching" — `/model` only switches models.
    a: "/fit (scores models vs your hardware), /pull <id> (gated download into the store of the server that runs it — Ollama, LM Studio or the Hugging Face cache; Prometheus keeps no copy), /hw (hardware budget), /endpoints (live runners). Model-running tools (AirLLM, FlashAttention …): /models tools, /models install <tool>.",
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
    a: "Everything Prometheus keeps lives under ~/.prometheus (config, downloads/{videos,audio,files}, cache, logs, records, state). Models do not: each lives in its server's own store (Ollama's ~/.ollama/models, LM Studio's models folder, the Hugging Face cache) — /paths lists them. Run /paths to repoint heavy-download folders (videos/audio/files) to another disk — Tab-completes. Override the root with $PROMETHEUS_HOME.",
    keywords: ["folder", "directory", "download path", "disk", "storage", "~/.prometheus", "home"],
  },
  {
    topic: "requirements",
    q: "What do I need to install? Which dependencies does Prometheus use?",
    a: "Run `prometheus requirements`: it lists what this machine has and what is missing (git; tmux, bubblewrap and, on a Linux desktop, secret-tool are optional), shows the one command for your OS (apt-get, dnf, yum, rpm-ostree, brew…), and offers to run it — each step through the privileged gate, approved by you, with sudo asking for your password in the terminal. Node.js, Python and ripgrep come with install.sh, privately and without root. `sh install.sh --check` prints the same scan; `sh install.sh --deps` runs just that step (and offers Homebrew on a Mac that has none).",
    keywords: [
      "requirements",
      "dependencies",
      "deps",
      "what to install",
      "prerequisites",
      "missing",
      "sudo",
      "apt",
      "dnf",
      "brew",
    ],
  },
  {
    topic: "freellmapi",
    q: "Can Prometheus use FreeLLMAPI (one key for many providers' free tiers)?",
    a: "Yes: `prometheus freellmapi setup` (or /freellmapi setup) checks Node 20.18–24, fetches a pinned release, and runs nemesis on exactly what would be installed — ANY critical advisory refuses the install, every time you try, with the reasons listed and nothing to override; it installs the day upstream ships a release without one. Once installed it runs on 127.0.0.1 only, under a 512 MB RAM cap and a 6-hourly advisory re-check that stops and quarantines it if a critical advisory appears. In its dashboard add ONE key per provider and leave the anonymous rows off (Kilo logs free prompts for training); then `prometheus freellmapi connect` and pick FreeLLMAPI → auto in /models. Its prompts leave your machine, so Prometheus treats it as cloud: a local-only policy blocks it.",
    keywords: [
      "freellmapi",
      "free api",
      "free tokens",
      "free tier",
      "gateway",
      "router",
      "one key",
      "rotation",
    ],
  },
  {
    topic: "services",
    q: "What is watching the apps Prometheus installed? Can it kill them?",
    a: "Every long-running process Prometheus starts for a third party — a self-hosted app's server, a docker app you enabled, FreeLLMAPI — is registered with one watcher. It stops a service whose memory stays over its cap for three polls in a row (a spike never kills), stops them all if the kernel reports critical memory pressure, and every 6 hours re-gates their lockfiles against a fresh advisory database: a CRITICAL advisory stops the service and quarantines it until a re-install passes the gate. A scanner error is logged and never kills. See them with `prometheus services` (/services); change a cap with `prometheus services cap <name> <MB>`.",
    keywords: [
      "services",
      "watch",
      "watchdog",
      "ram",
      "memory",
      "kill switch",
      "quarantine",
      "cap",
    ],
  },
  {
    topic: "tmux",
    q: "Do I need tmux? How do subagents work?",
    a: "No — tmux is optional. Sub-agents run in-process everywhere: the model delegates when it helps, up to the cap /agents [n] shows and sets; /orchestrate <task> decomposes a big task. Roster: build · plan · explore · scout. Without tmux, Prometheus runs in compatibility mode: --tmux opens the normal single-window session, chat --cli X --tmux opens the chat in this terminal, and /demos runs its swarm headless. With tmux you also get extra windows (3 subagents by default, auto-scaled). Force compatibility mode with --no-tmux or PROMETHEUS_NO_TMUX=1.",
    keywords: [
      "subagent",
      "orchestrator",
      "parallel",
      "team",
      "agents",
      "panes",
      "tmux",
      "without tmux",
      "no tmux",
      "compatibility",
    ],
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
    a: 'Color auto-disables when stdout isn\'t a detected TTY (or NO_COLOR / TERM=dumb is set). Force it on with FORCE_COLOR=1 (e.g. `FORCE_COLOR=1 prometheus`). Check yours: node -e "console.log(process.stdout.isTTY)".',
    keywords: ["colour", "ansi", "no color", "force_color", "tty"],
  },
  {
    topic: "no-model",
    q: "Chat says no model / 'ollama unreachable'. What now?",
    a: "No local runner is serving a model. Type /setup to download a free local model (Ollama), or connect a paid CLI. A paid model name (e.g. claude-opus) can't run locally — use /model ollama:<tag> for local, or `prometheus chat --cli claude --open`.",
    keywords: ["unreachable", "no backend", "ollama down", "model error", "server"],
  },
  {
    topic: "commands",
    q: "What commands are available?",
    a: "/commands lists every /command grouped; /help shows the top ones. Anything you can do as `prometheus <verb>` you can do as a /verb in-session, plus session/agent/review macros.",
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
    a: "Run /doctor (OS/agents/git/paths) or `prometheus doctor --bridge` (engine discovery). /status shows the session config. Most read commands are fail-closed — a clear error beats a wrong 'ok'.",
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
