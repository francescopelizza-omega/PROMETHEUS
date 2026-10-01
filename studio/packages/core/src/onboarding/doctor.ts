// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * onboarding/doctor.ts — "what is missing, why it matters, and exactly what to type".
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────────────────────
 *
 * A beginner installs PROMETHEUS on a clean machine, types a question, and gets an error about
 * a model endpoint. Nothing tells them that PROMETHEUS does not CONTAIN a model, that a
 * separate program has to run one, which program, or how to get it. Every piece of that is
 * knowable — the probes already exist — and none of it was ever assembled into an answer.
 *
 * ── WHY "WHY" IS A FIRST-CLASS FIELD ────────────────────────────────────────────────────────
 *
 * A list of package names with no reasons is a list of things to distrust. "Install ollama"
 * invites the question a newcomer cannot answer for themselves — is this PROMETHEUS's
 * dependency, or something it wants me to sign up for? So every requirement carries a `why`
 * key alongside its `what`, and the renderer never prints one without the other.
 *
 * ── WHY THE COMMANDS ARE DATA AND NOT PROSE ─────────────────────────────────────────────────
 *
 * `install` is a per-platform command STRING, never assembled from translated fragments. A
 * localised shell command does not run, and an instruction that looks authoritative and fails
 * is worse than no instruction. The prose around it is translated; the command is not.
 *
 * PURE: takes a snapshot, returns a report. No probing, no fs, no spawning — the caller does
 * that and hands the facts in, which is what makes the whole thing testable without a machine
 * in a particular state.
 */

import type { MessageKey } from "../i18n/index.js";

/** The package managers a first-time install realistically goes through. */
export type PackageManager = "brew" | "apt" | "dnf" | "pacman" | "winget" | "none";

/** What a requirement needs in order to be considered met. */
export type RequirementId = "node" | "ollama" | "model" | "ripgrep" | "git";

export type RequirementTier = "required" | "optional";

export interface Requirement {
  id: RequirementId;
  tier: RequirementTier;
  /** i18n key: the one-line name and purpose. */
  whatKey: MessageKey;
  /** i18n key: why PROMETHEUS needs it, in a newcomer's terms. */
  whyKey: MessageKey;
  /**
   * The command, per platform. NOT translated — see the module header.
   *
   * `undefined` for a platform means "we do not know a command here", which the renderer says
   * out loud rather than guessing; a wrong install command is worse than an honest gap.
   */
  install: Partial<Record<PackageManager, string>>;
  /** an i18n key for a follow-up step, when installing the thing is not the whole job. */
  afterKey?: MessageKey;
  /** the project's own page, for a user who wants to check before pasting a command. */
  docs?: string;
  /**
   * A requirement that is meaningless until another one is met.
   *
   * "Download a model" is not an independent task when there is nothing to download it WITH,
   * and listing it anyway produced a contradiction on a bare machine: the model entry said
   * "Ollama is installed but has no model yet" directly beneath the entry saying Ollama was
   * missing. A dependent requirement is held back until its parent is satisfied — the parent's
   * own `afterKey` is what tells the user it is coming.
   */
  dependsOn?: RequirementId;
}

/**
 * The foundation set.
 *
 * Deliberately SHORT and distinct from `agent/host-tools.ts`. That registry is the ~25 media
 * and document tools a model reaches for mid-task; this is the handful without which there is
 * no conversation at all. Mixing them would bury "you have no AI model" in a list that also
 * mentions `jpegoptim`.
 */
export const REQUIREMENTS: readonly Requirement[] = Object.freeze([
  {
    id: "node",
    tier: "required",
    whatKey: "need.node.what",
    whyKey: "need.node.why",
    // If PROMETHEUS is running at all, Node exists — what can fail is the VERSION, and neither
    // brew nor apt reliably gives 22+, so nvm is the honest answer on both.
    install: {
      brew: "brew install node@22",
      apt: "curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22",
      winget: "winget install OpenJS.NodeJS.LTS",
    },
    docs: "https://nodejs.org",
  },
  {
    id: "ollama",
    tier: "required",
    whatKey: "need.ollama.what",
    whyKey: "need.ollama.why",
    afterKey: "need.ollama.after",
    install: {
      brew: "brew install ollama",
      // Ollama ships no apt/dnf package; its own script is the documented route. The renderer
      // pairs this with `common.gated` so the user knows what PROMETHEUS does and does not
      // check when a command pipes a download into a shell.
      apt: "curl -fsSL https://ollama.com/install.sh | sh",
      dnf: "curl -fsSL https://ollama.com/install.sh | sh",
      pacman: "curl -fsSL https://ollama.com/install.sh | sh",
      winget: "winget install Ollama.Ollama",
    },
    docs: "https://ollama.com/download",
  },
  {
    id: "model",
    tier: "required",
    whatKey: "need.model.what",
    whyKey: "need.model.why",
    // Held back until ollama exists: see `dependsOn`. The model's own "why" text reads
    // "Ollama is installed but has no model yet", which is a contradiction on a bare machine.
    dependsOn: "ollama",
    // Filled in per-machine by `suggestModel`: the tag depends on how much memory is free, so
    // there is no fixed command here.
    install: {},
    docs: "https://ollama.com/library",
  },
  {
    id: "ripgrep",
    tier: "required",
    whatKey: "need.ripgrep.what",
    whyKey: "need.ripgrep.why",
    install: {
      brew: "brew install ripgrep",
      apt: "sudo apt-get install -y ripgrep",
      dnf: "sudo dnf install -y ripgrep",
      pacman: "sudo pacman -S --noconfirm ripgrep",
      winget: "winget install BurntSushi.ripgrep.MSVC",
    },
    docs: "https://github.com/BurntSushi/ripgrep",
  },
  {
    id: "git",
    tier: "optional",
    whatKey: "need.git.what",
    whyKey: "need.git.why",
    install: {
      brew: "brew install git",
      apt: "sudo apt-get install -y git",
      dnf: "sudo dnf install -y git",
      pacman: "sudo pacman -S --noconfirm git",
      winget: "winget install Git.Git",
    },
    docs: "https://git-scm.com",
  },
]);

/** What the caller measured. Every field optional: an unknown is not a failure. */
export interface MachineFacts {
  platform: NodeJS.Platform;
  /** the first package manager found on PATH, or "none". */
  manager: PackageManager;
  /** which requirement ids resolved to a binary. */
  present: ReadonlySet<RequirementId>;
  /** ollama answered its HTTP API. */
  runnerUp?: boolean;
  /** how many models are downloaded. */
  modelCount?: number;
  /** a cloud provider key is configured, so a local model is not strictly required. */
  cloudConfigured?: boolean;
  /** bytes a model could use, from the memory probe. */
  availableBytes?: number;
  /** the running Node major version. */
  nodeMajor?: number;
}

export type RequirementState =
  | "ok"
  | "missing"
  /** installed, but not doing its job yet — ollama present and not serving. */
  | "idle"
  /** we could not tell, and say so rather than guessing. */
  | "unknown";

export interface RequirementResult {
  requirement: Requirement;
  state: RequirementState;
  /** the command for THIS machine, or null when none is known for its platform. */
  command: string | null;
  /** true when this requirement is what stands between the user and a working prompt. */
  blocking: boolean;
  /** held back because `dependsOn` is not satisfied yet — shown by neither list. */
  deferred?: boolean;
}

export interface DoctorReport {
  results: readonly RequirementResult[];
  /** can the user have a conversation right now? */
  ready: boolean;
  /** required things that are not satisfied, in the order they should be fixed. */
  blockers: readonly RequirementResult[];
  optional: readonly RequirementResult[];
  manager: PackageManager;
}

/** The minimum Node this repo can run on — `engines.node` and `.nvmrc` agree on 22. */
export const MIN_NODE_MAJOR = 22;

/**
 * Decide the state of one requirement.
 *
 * Split out because the interesting logic is entirely in the special cases, and a reader
 * should be able to see them side by side.
 */
export function stateOf(req: Requirement, facts: MachineFacts): RequirementState {
  switch (req.id) {
    case "node":
      // Node is running (we are inside it), so only the version can be wrong.
      return facts.nodeMajor === undefined
        ? "unknown"
        : facts.nodeMajor >= MIN_NODE_MAJOR
          ? "ok"
          : "missing";
    case "ollama":
      if (!facts.present.has("ollama")) return "missing";
      // Installed but not serving is a DIFFERENT problem with a different fix, and collapsing
      // the two sends the user to reinstall something they already have.
      return facts.runnerUp === false ? "idle" : "ok";
    case "model":
      if (facts.modelCount === undefined) return "unknown";
      return facts.modelCount > 0 ? "ok" : "missing";
    default:
      return facts.present.has(req.id) ? "ok" : "missing";
  }
}

/**
 * The full report.
 *
 * ORDER IS THE POINT. The blockers come back in dependency order — there is no use telling
 * someone to download a model before they have anything to run it with — and the renderer
 * prints them in exactly that order so the list reads as a sequence of steps rather than a
 * pile of complaints.
 */
export function diagnose(facts: MachineFacts): DoctorReport {
  const results = REQUIREMENTS.map((requirement): RequirementResult => {
    const state = stateOf(requirement, facts);
    /*
     * A cloud key removes the LOCAL-STACK requirements, not all of them.
     *
     * Someone with an Anthropic key does not need ollama or a downloaded model, and telling
     * them otherwise is noise that makes the whole report look untrustworthy. ripgrep and Node
     * are still needed — those are PROMETHEUS's own dependencies, not the model's.
     */
    const localStack = requirement.id === "ollama" || requirement.id === "model";
    const required = requirement.tier === "required" && !(localStack && facts.cloudConfigured);
    // A dependent requirement waits its turn — see `Requirement.dependsOn`.
    const parentReady =
      requirement.dependsOn === undefined ||
      stateOf(REQUIREMENTS.find((x) => x.id === requirement.dependsOn) as Requirement, facts) ===
        "ok";
    return {
      requirement,
      state,
      command: commandFor(requirement, facts.manager),
      // "unknown" never blocks: failing to measure must not read as failing.
      blocking: required && parentReady && (state === "missing" || state === "idle"),
      ...(parentReady ? {} : { deferred: true }),
    };
  });
  const blockers = results.filter((r) => r.blocking);
  return {
    results,
    ready: blockers.length === 0,
    blockers,
    // A deferred requirement belongs in NEITHER list: it is not a blocker the user can act on
    // and it is not optional. It reappears as a blocker once its parent is installed.
    optional: results.filter((r) => !r.blocking && !r.deferred && r.state !== "ok"),
    manager: facts.manager,
  };
}

/** The install command for this machine, or null when none is known for its manager. */
export function commandFor(req: Requirement, manager: PackageManager): string | null {
  return req.install[manager] ?? null;
}

/**
 * Which model to suggest first, given the memory actually free.
 *
 * Small on purpose. A first model that takes forty minutes to download and then does not fit
 * teaches the user that this does not work; one that starts answering in five minutes teaches
 * them that it does. They can move up immediately afterwards, and `/ram` shows them how far.
 *
 * Sizes are the on-disk Q4_K_M figures, and the comparison is against memory that is FREE
 * rather than installed — the same basis `ai/model-admission.ts` uses.
 */
export const STARTER_MODELS: readonly { tag: string; bytes: number; label: string }[] =
  Object.freeze([
    { tag: "qwen3:8b", bytes: 5.2e9, label: "8B" },
    { tag: "llama3.2:3b", bytes: 2.0e9, label: "3B" },
    { tag: "qwen3:1.7b", bytes: 1.4e9, label: "1.7B" },
  ]);

/** Enough headroom that the model loads AND leaves the machine usable. */
export const STARTER_HEADROOM_BYTES = 2 * 1024 ** 3;

export function suggestModel(
  availableBytes: number | undefined,
): { tag: string; bytes: number } | null {
  if (availableBytes === undefined || availableBytes <= 0) return null;
  const usable = availableBytes - STARTER_HEADROOM_BYTES;
  // Biggest that fits: the list is ordered large-to-small, so the first match is the best one.
  return STARTER_MODELS.find((m) => m.bytes <= usable) ?? null;
}
