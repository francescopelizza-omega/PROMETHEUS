/**
 * i18n/messages/en.ts — the English catalog, which is also the SCHEMA.
 *
 * `Messages` in `../catalog.ts` is `typeof en`, so adding a key here is what creates it and
 * every translation is typed as a `Partial` of this. Two consequences worth knowing before
 * editing:
 *
 *   - RENAMING a key here breaks every translation that had it, loudly, at compile time. Good:
 *     the alternative is a translation silently reverting to English.
 *   - The English text is the SOURCE. Translators read it, so it has to say what it means
 *     without the surrounding code for context.
 *
 * ── SCOPE: WHO THIS IS FOR ──────────────────────────────────────────────────────────────────
 *
 * Not the whole application. This is the text a person meets in their first ten minutes —
 * choosing a language, finding out what is missing, and being told exactly how to fix it. That
 * is the slice where a wrong language actually costs someone the product; an experienced user
 * reading `/ram` output in English is mildly annoyed, a beginner who cannot tell whether
 * PROMETHEUS is broken or merely unconfigured gives up.
 *
 * ── STYLE ───────────────────────────────────────────────────────────────────────────────────
 *
 * Say what is wrong, why it matters, and what to type. Never blame the user. Never say
 * "simply" or "just" — if it were simple they would not be reading this. A command the user
 * must run is NOT translated: `brew install ollama` is the same in every language, and
 * translating it would break it.
 */

export const en = {
  /* ── first run: the language question, asked in English ─────────────────── */
  // Deliberately in English: this is the one screen shown BEFORE we know what they read, so it
  // uses the language most likely to be understood by someone who has not chosen yet. Every
  // option is labelled with its own endonym so the right row is recognisable regardless.
  "firstrun.language.title": "Choose your language",
  "firstrun.language.intro":
    "PROMETHEUS can speak several languages. This question is in English because it is asked before you have chosen; everything after it follows your answer.",
  "firstrun.language.prompt": "Pick a number, or press Enter for English:",
  "firstrun.language.detected": "Your system suggests {language} — press Enter to accept it.",
  "firstrun.language.confirmed": "Language set to {language}. Change it any time with /language.",
  "firstrun.language.partial":
    "{language} is {percent}% translated; anything not yet translated appears in English.",

  /* ── first run: welcome ──────────────────────────────────────────────────── */
  "firstrun.welcome.title": "Welcome to PROMETHEUS",
  "firstrun.welcome.body":
    "PROMETHEUS runs AI models on your own machine and lets them work with your files, run commands you approve, and search the web. Nothing leaves this computer unless you connect a cloud provider yourself.",
  "firstrun.welcome.next":
    "Let us check what is already installed. This takes a few seconds and changes nothing.",
  "firstrun.newhere":
    "New to this? Type /guide for a walkthrough, or /doctor at any time to see what is missing.",

  /* ── the doctor: headline verdicts ───────────────────────────────────────── */
  "doctor.title": "Setup check",
  "doctor.checking": "Checking what is installed…",
  "doctor.ready.title": "You are ready to go",
  "doctor.ready.body": "Everything PROMETHEUS needs is installed. Type a question to begin.",
  "doctor.blocked.title": "PROMETHEUS cannot run a model yet",
  "doctor.blocked.body":
    "{count} required item is missing. The commands below install it; you can copy them one at a time.",
  "doctor.blocked.body.plural":
    "{count} required items are missing. The commands below install them; you can copy them one at a time.",
  "doctor.optional.title": "Optional extras",
  "doctor.optional.body":
    "These are not required. Each one unlocks something specific, listed beside it.",
  "doctor.recheck": "Run /doctor again after installing to confirm.",

  /* ── the doctor: status words ────────────────────────────────────────────── */
  "doctor.status.installed": "installed",
  "doctor.status.missing": "missing",
  "doctor.status.required": "required",
  "doctor.status.optional": "optional",
  "doctor.status.running": "running",
  "doctor.status.stopped": "installed but not running",
  "doctor.label.why": "Why",
  "doctor.label.install": "Install",
  "doctor.label.then": "Then",
  "doctor.label.unlocks": "Unlocks",
  "doctor.label.docs": "More",

  /* ── the doctor: per-item explanations ───────────────────────────────────── */
  // The "why" is the part that is usually missing from tooling, and it is the part a beginner
  // needs: a list of package names with no reasons is a list of things to distrust.
  "need.ollama.what": "Ollama — runs AI models on your computer",
  "need.ollama.why":
    "PROMETHEUS does not contain an AI model. Ollama is the program that loads one and answers prompts, locally and offline. Without it there is nothing to talk to.",
  "need.ollama.after":
    "Once installed, start it and download a model — /doctor will suggest one that fits your memory.",
  "need.model.what": "An AI model",
  "need.model.why":
    "Ollama is installed but has no model yet. A model is the file that does the thinking; they range from about 2 GB to over 40 GB.",
  "need.model.suggest":
    "For your {memory} of free memory, {model} is a good first choice ({size}).",
  "need.model.none":
    "No model in the catalogue fits the memory currently free. Closing other applications, or choosing a smaller model, will help.",
  "need.ripgrep.what": "ripgrep — fast file search",
  "need.ripgrep.why":
    "PROMETHEUS uses ripgrep to search your files. Without it the search tool fails, and the model loses the ability to find code on its own.",
  "need.git.what": "git — version control",
  "need.git.why":
    "Needed to clone repositories and to show the model what changed in your project. Most systems already have it.",
  "need.node.what": "Node.js 22 or newer",
  "need.node.why":
    "PROMETHEUS itself runs on Node. Version 22 is the minimum because it reads TypeScript sources directly; older versions fail before anything starts.",

  /* ── connectivity / runner state ─────────────────────────────────────────── */
  "runner.notinstalled":
    "Ollama is not installed on this computer, so there is no local model to answer with.",
  "runner.notrunning":
    "Ollama is installed but not currently running. PROMETHEUS can start it, or you can run: ollama serve",
  "runner.starting": "Starting Ollama…",
  "runner.nomodels":
    "Ollama is running but has no models downloaded. Download one with: ollama pull {model}",
  "runner.unreachable":
    "Could not reach a model server at {url}. If it is on another machine, check that it is switched on and that /remote lists it.",

  /* ── cloud alternative ───────────────────────────────────────────────────── */
  "cloud.alternative.title": "Or use a cloud provider instead",
  "cloud.alternative.body":
    "If you would rather not download a model, PROMETHEUS can use a paid API instead. Set the provider's key as an environment variable and it appears in /model. Your prompts then leave this computer — that is the trade.",

  /* ── the guided walkthrough ──────────────────────────────────────────────── */
  "guide.title": "Getting started",
  "guide.step": "Step {n} of {total}",
  "guide.step1.title": "Install a model runner",
  "guide.step1.body":
    "This is the program that actually runs the AI. /doctor shows the exact command for your system.",
  "guide.step2.title": "Download a model",
  "guide.step2.body":
    "Models differ in size and skill. A bigger model is more capable and needs more memory; /ram shows which ones fit your machine.",
  "guide.step3.title": "Ask something",
  "guide.step3.body":
    "Type a question in plain language. To work on files, open a folder first with /cd, then describe what you want changed.",
  "guide.step4.title": "Approving actions",
  "guide.step4.body":
    "Before the model writes a file, runs a command or reaches the network, PROMETHEUS asks you. /auth sets how often it asks — start cautious and relax it once you trust what you see.",
  "guide.step5.title": "Where to look next",
  "guide.step5.body":
    "/help lists every command. /doctor re-checks your setup. /language changes the language. /ram shows which models fit.",
  "guide.done": "That is the whole tour. Ask a question whenever you are ready.",

  /* ── shared, plain-language framing ──────────────────────────────────────── */
  "common.notinstalled": "not installed",
  "common.copycommand": "Copy and run this in your terminal:",
  "common.needsadmin": "This needs administrator rights and will ask for your password.",
  "common.nointernet":
    "This step downloads from the internet. If you are offline, it will fail until you reconnect.",
  "common.safe":
    "PROMETHEUS never runs an install for you without showing the command and asking first.",
  "common.gated":
    "Anything PROMETHEUS downloads is scanned before it is allowed to run. A scan that fails blocks the install.",
  "common.cancelled": "Cancelled. Nothing was changed.",
  "common.unknownos":
    "PROMETHEUS does not recognise this operating system, so it cannot suggest an install command. The project's own page will have one.",

  /* ── the /language command ───────────────────────────────────────────────── */
  "language.current": "Language: {language} ({source}).",
  "language.source.setting": "your choice",
  "language.source.environment": "from your system settings",
  "language.source.fallback": "default",
  "language.available": "Available languages:",
  "language.usage": "Usage: /language <code>, or /language to choose from a list.",
  "language.unknown": "{code} is not one of the available languages.",
  "language.help": "Show or change the language PROMETHEUS speaks.",

  /* ── the help menu framing (the command NAMES stay English) ─────────────── */
  "help.title": "Prometheus session — help",
  "help.intro":
    "Type a message to chat · a command starting with / runs an action · a bare verb (scan) runs it.",
  "help.total": "{count} commands total — /commands for all.",
  "commands.title": "Commands",
  "commands.hint": "{count} commands — type / followed by a name",
} as const;
