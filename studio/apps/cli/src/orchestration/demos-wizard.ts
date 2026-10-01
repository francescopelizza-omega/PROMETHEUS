// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/demos-wizard.ts — the `/demos` setup: detect → propose → customize → persist.
 *
 * Detects which vendor AI CLIs are installed (on PATH) AND authenticated (auth probe), plus
 * any local models, then PROPOSES a sensible swarm topology and lets the user accept it or
 * type a custom one. The pure pieces — `detectClis`, `proposeTopology`, `parseTopologySpec`
 * — are unit-tested; `runDemosWizard` is the thin interactive shell over the SlashCtx seams.
 */
import { constants, accessSync } from "node:fs";
import { join } from "node:path";

import { orchestration as orch, type orchestration } from "@prometheus/core";

import { RECIPE_SERVICES, type RecipeRequirement, recipeFor } from "./recipes.js";
import { type SpawnCapture, makeSpawnCapture } from "./spawn-capture.js";

type OrchestrationTopology = orchestration.OrchestrationTopology;
type AgentSpec = orchestration.AgentSpec;
const { normalizeTopology, parseBackendRef, validateTopology } = orch;

/** The detected state of one CLI service. */
export interface CliStatus {
  service: string;
  bin: string;
  installed: boolean;
  authed: boolean;
  note: string;
}

/* ── readiness classification (CLI-071) ───────────────────────────────────────── */

/** The precise reason a backend isn't ready — each maps to a distinct remedy. */
export type ReadinessCause =
  | "missing-binary"
  | "no-api-key"
  | "not-logged-in"
  | "invalid-key"
  | "endpoint"
  | "unreachable"
  | "network";

export interface Readiness {
  ready: boolean;
  cause?: ReadinessCause;
  /** the human "cause: …" text (names the env var / check). */
  detail?: string;
  /** the one actionable "remedy: …" step. */
  remedy?: string;
}

/**
 * Classify a detected CLI's readiness (OFFLINE, pure — CLI-071). A missing binary, an env-key
 * backend with no key, and a cli-login backend not-logged-in each get a DISTINCT cause + remedy
 * (naming the env var / install / login command). A ready backend returns `{ready:true}`.
 */
export function classifyReadiness(status: CliStatus, req?: RecipeRequirement): Readiness {
  if (!status.installed) {
    return {
      ready: false,
      cause: "missing-binary",
      detail: `binary '${status.bin}' not found on PATH`,
      remedy: req?.install ?? `install ${status.bin}`,
    };
  }
  if (!status.authed) {
    if (req?.authMode === "env-key") {
      return {
        ready: false,
        cause: "no-api-key",
        detail: req.envVar ? `no API key ($${req.envVar} unset)` : "no API key set",
        remedy: req.envVar ? `set $${req.envVar}` : "set the provider API key",
      };
    }
    return {
      ready: false,
      cause: "not-logged-in",
      detail: "not logged in",
      remedy: req?.login ?? `${status.bin} login`,
    };
  }
  return { ready: true };
}

/**
 * Classify a LIVE key-verify failure by its HTTP status / socket error (CLI-071). Used by the
 * gated verify path (GET /v1/models); PURE mapping so it's testable without a network. 401/403 ⇒
 * invalid-key (name the env var), 404 ⇒ endpoint/model, ECONNREFUSED/ENOTFOUND ⇒ unreachable.
 */
export function classifyHttpFailure(
  httpStatus: number | undefined,
  errCode: string | undefined,
  envVar?: string,
): Readiness {
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      ready: false,
      cause: "invalid-key",
      detail: `endpoint rejected the key (HTTP ${httpStatus})`,
      remedy: envVar ? `check/replace $${envVar}` : "check the provider API key",
    };
  }
  if (httpStatus === 404) {
    return {
      ready: false,
      cause: "endpoint",
      detail: "model or endpoint not found (HTTP 404)",
      remedy: "check the base URL / model id",
    };
  }
  if (errCode === "ECONNREFUSED" || errCode === "ENOTFOUND") {
    return {
      ready: false,
      cause: "unreachable",
      detail: `endpoint unreachable (${errCode})`,
      remedy: "check the base URL / network",
    };
  }
  if (errCode === "ETIMEDOUT" || errCode === "timeout") {
    return {
      ready: false,
      cause: "network",
      detail: "verify timed out",
      remedy: "retry / check the network",
    };
  }
  return { ready: true };
}

/** Render one readiness verdict as a `✓ ready` / `✗ cause: … remedy: …` line (CLI-071). */
export function readinessLine(service: string, r: Readiness): string {
  return r.ready
    ? `✓ ${service} — ready`
    : `✗ ${service} — cause: ${r.detail ?? r.cause} — remedy: ${r.remedy ?? "(see docs)"}`;
}

export interface DetectDeps {
  which?: (bin: string) => boolean;
  spawn?: SpawnCapture;
}

/** Probe every recipe: is its bin on PATH, and (if it has an auth probe) is it logged in? */
export async function detectClis(deps: DetectDeps = {}): Promise<CliStatus[]> {
  const which = deps.which ?? defaultWhich;
  const spawn = deps.spawn ?? makeSpawnCapture();
  const out: CliStatus[] = [];
  for (const service of RECIPE_SERVICES) {
    const r = recipeFor(service);
    if (!r) continue;
    const bin = [r.bin, ...(r.binFallbacks ?? [])].find(which);
    const installed = bin !== undefined;
    let authed = false;
    if (installed && r.authProbe && r.authProbe.length > 0) {
      try {
        const probe = await spawn(bin as string, {
          args: [...r.authProbe],
          timeoutMs: 15_000,
          idleMs: 10_000,
        });
        authed = probe.outcome === "ok" || probe.outcome === "empty";
      } catch {
        authed = false;
      }
    } else if (installed) {
      authed = true; // file-based auth (no probe) — assume the user logged in
    }
    out.push({ service, bin: bin ?? r.bin, installed, authed, note: r.note });
  }
  return out;
}

function defaultWhich(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const d of dirs) {
    try {
      accessSync(join(d, bin), constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

const SPECIALTIES = [
  "backend code",
  "frontend / UI",
  "tests",
  "code review",
  "docs",
  "data / scripts",
];

/**
 * Propose a default topology from what's available: the orchestrator is the first
 * AUTHED CLI (claude preferred), and every other authed CLI becomes a child subagent
 * with a rotating specialty. Local models fill in when no CLIs are authed, so `/demos`
 * always produces a runnable swarm (worst case: a single local/fake orchestrator).
 */
export function proposeTopology(
  statuses: CliStatus[],
  localModels: string[] = [],
): OrchestrationTopology {
  const ready = statuses.filter((s) => s.installed && s.authed).map((s) => s.service);
  const ordered = [...ready].sort((a, b) =>
    a === "claude" ? -1 : b === "claude" ? 1 : a.localeCompare(b),
  );

  const agents: AgentSpec[] = [];
  let orchestrator: string;

  if (ordered.length > 0) {
    orchestrator = ordered[0] as string;
    const children = ordered.slice(1);
    agents.push({
      name: orchestrator,
      backend: { kind: "cli", service: orchestrator },
      role: "orchestrate the swarm",
      children,
    });
    children.forEach((svc, i) => {
      agents.push({
        name: svc,
        backend: { kind: "cli", service: svc },
        role: SPECIALTIES[i % SPECIALTIES.length] as string,
      });
    });
    // if only one CLI, add a local helper so there's a real subagent
    if (children.length === 0 && localModels.length > 0) {
      const helper = "local1";
      (agents[0] as AgentSpec).children = [helper];
      agents.push({
        name: helper,
        backend: { kind: "local", model: localModels[0] as string },
        role: "tests",
      });
    }
  } else if (localModels.length > 0) {
    orchestrator = "local";
    const kids = localModels.slice(1, 4);
    agents.push({
      name: "local",
      backend: { kind: "local", model: localModels[0] as string },
      role: "orchestrate",
      children: kids.map((_, i) => `worker${i + 1}`),
    });
    kids.forEach((m, i) =>
      agents.push({
        name: `worker${i + 1}`,
        backend: { kind: "local", model: m },
        role: SPECIALTIES[i % SPECIALTIES.length] as string,
      }),
    );
  } else {
    orchestrator = "demo";
    agents.push({
      name: "demo",
      backend: { kind: "fake" },
      role: "orchestrate (no backend detected — dry run)",
    });
  }

  return normalizeTopology({ orchestrator, agents });
}

// name = <backend-token> [:] <role...> [-> child, child]
// backend is a single non-space token (so "local:qwen2.5" stays intact); the separator
// before the role is an optional ":" then whitespace.
const LINE_RE = /^(\w[\w-]*)\s*=\s*(\S+?)\s*:?\s+(.+?)(?:\s*->\s*(.*))?$/;

/**
 * Parse a custom topology spec — one agent per line:
 *   `name = backend : role`   (optionally  `-> child1, child2`)
 * The FIRST line is the orchestrator. `backend` is a token parseBackendRef understands
 * (claude / codex / local:qwen / engine:llama / fake). Returns a normalized topology.
 */
export function parseTopologySpec(text: string): OrchestrationTopology {
  const agents: AgentSpec[] = [];
  let orchestrator = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, name, backendTok, role, childCsv] = m as unknown as [
      string,
      string,
      string,
      string,
      string | undefined,
    ];
    const children = (childCsv ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (!orchestrator) orchestrator = name;
    agents.push({
      name,
      backend: parseBackendRef(backendTok.trim()),
      role: role.trim(),
      ...(children.length > 0 ? { children } : {}),
    });
  }
  return normalizeTopology({ orchestrator, agents });
}

/** Render a topology back to the spec DSL (for display / editing). */
export function topologyToSpec(t: OrchestrationTopology): string {
  const backendTok = (a: AgentSpec): string => {
    const b = a.backend;
    if (b.kind === "cli") return b.service ?? "cli";
    if (b.kind === "api") return `api:${b.service ?? "?"}${b.model ? `:${b.model}` : ""}`;
    if (b.kind === "local") return `local:${b.model ?? "default"}`;
    if (b.kind === "engine-chat") return `engine:${b.model ?? "default"}`;
    return b.kind;
  };
  // orchestrator first, then the rest
  const ordered = [...t.agents].sort((a, b) =>
    a.name === t.orchestrator ? -1 : b.name === t.orchestrator ? 1 : 0,
  );
  return ordered
    .map(
      (a) =>
        `${a.name} = ${backendTok(a)} : ${a.role}${a.children?.length ? ` -> ${a.children.join(", ")}` : ""}`,
    )
    .join("\n");
}

/** The interactive seams the host (SlashCtx) provides. */
export interface WizardSeams {
  write: (line: string) => void;
  ask: (prompt: string) => Promise<string>;
  confirm: (prompt: string) => Promise<boolean>;
  detect: () => Promise<CliStatus[]>;
  localModels: () => Promise<string[]>;
}

/** Run the interactive setup; returns a validated topology (caller persists it). */
export async function runDemosWizard(seams: WizardSeams): Promise<OrchestrationTopology | null> {
  seams.write("Detecting installed + authenticated AI CLIs…");
  const statuses = await seams.detect();
  const models = await seams.localModels().catch(() => []);

  seams.write("\nDetected backends:");
  for (const s of statuses) {
    const mark = !s.installed
      ? "·  not installed"
      : s.authed
        ? "✓  ready"
        : "○  installed, not logged in";
    seams.write(`  ${s.service.padEnd(10)} ${mark}`);
  }
  if (models.length > 0) seams.write(`  local models: ${models.join(", ")}`);

  let topo = proposeTopology(statuses, models);
  seams.write("\nProposed swarm (orchestrator first):");
  seams.write(topologyToSpec(topo));

  const accept = await seams.confirm("\nUse this swarm?");
  if (!accept) {
    seams.write(
      [
        "Type your swarm — one agent per line, the FIRST is the orchestrator:",
        "  name = backend : role  [-> child1, child2]",
        "backends: claude codex gemini cursor aider opencode hermes cline kilocode  ·  local:<model>  ·  engine:<model>  ·  fake",
        "End with an empty line.",
      ].join("\n"),
    );
    const lines: string[] = [];
    for (;;) {
      const line = await seams.ask(lines.length === 0 ? "swarm>" : "      ");
      if (!line.trim()) break;
      lines.push(line);
    }
    if (lines.length > 0) topo = parseTopologySpec(lines.join("\n"));
  }

  const v = validateTopology(topo);
  if (!v.ok) {
    seams.write(`\nTopology invalid:\n  ${v.errors.join("\n  ")}`);
    return null;
  }
  return topo;
}
