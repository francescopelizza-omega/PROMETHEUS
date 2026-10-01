// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/doctor-host.ts — measure the machine, so `onboarding/doctor.ts` can judge it.
 *
 * The split is the point: everything that TOUCHES the world is here, and everything that
 * DECIDES is in core, pure. That is what lets the six machine states a user can arrive in be
 * tested without putting a machine into any of them.
 *
 * Every probe here is fail-soft and bounded. A doctor that hangs, or that reports "missing"
 * because a probe timed out, is worse than no doctor — the whole point is to be the one screen
 * a confused beginner can trust.
 */
import { ai, type onboarding as ob } from "@prometheus/core";
import { lookPath } from "@prometheus/core/agent-system-host";
import { localMemorySnapshot, runnerCensus } from "@prometheus/engine-bridge";

/**
 * The package manager this machine installs with.
 *
 * FIRST MATCH, in the order a user would expect on their platform. `brew` is checked before
 * `apt` because a Mac with Homebrew and a Linuxbrew-style apt shim should get the brew command,
 * and on Linux `brew` is simply absent so the order costs nothing.
 */
export function detectManager(
  platform: NodeJS.Platform = process.platform,
  which: (bin: string) => string | null = (b) => lookPath(b),
): ob.PackageManager {
  if (platform === "win32") return which("winget") ? "winget" : "none";
  const order: ob.PackageManager[] =
    platform === "darwin" ? ["brew"] : ["apt", "dnf", "pacman", "brew"];
  for (const m of order) {
    // apt is invoked as `apt-get` in this repo's install flow, and that is the binary to test.
    if (which(m === "apt" ? "apt-get" : m)) return m;
  }
  return "none";
}

/** Which foundation binaries resolve on PATH. */
export function presentTools(
  which: (bin: string) => string | null = (b) => lookPath(b),
): Set<ob.RequirementId> {
  const found = new Set<ob.RequirementId>();
  // `rg` is the binary; `ripgrep` is the package. Probing the package name finds nothing and
  // reports a working install as missing — the exact false alarm this screen must not produce.
  if (which("rg")) found.add("ripgrep");
  if (which("ollama")) found.add("ollama");
  if (which("git")) found.add("git");
  return found;
}

/** Is a cloud provider configured? Then the local stack is optional. */
export function cloudConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  // Read from the registry rather than a hardcoded list, so a provider added there is not
  // silently missed here — which would tell a paying user to install ollama for no reason.
  return ai.discoverCloudEndpoints({ env }).length > 0;
}

/** The running Node major, or undefined if it cannot be read (never a guess). */
export function nodeMajor(version: string = process.versions.node): number | undefined {
  const n = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Everything the doctor needs, measured.
 *
 * The two network probes run CONCURRENTLY and are individually fail-soft: a runner that does
 * not answer is "not up", not an error, and a `/api/tags` that times out leaves `modelCount`
 * UNDEFINED rather than zero. That distinction matters — undefined means "could not tell" and
 * never blocks, where zero means "definitely none" and does.
 */
export async function gatherFacts(
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ob.MachineFacts> {
  const env = opts.env ?? process.env;
  const root = ai.ollamaRoot(opts.baseUrl ?? "http://127.0.0.1:11434");
  const present = presentTools();

  const [census, models, mem] = await Promise.all([
    runnerCensus([{ id: "ollama", baseUrl: root, api: "ollama" }], { timeoutMs: 1500 }).catch(
      () => [],
    ),
    // Only ask for models if ollama is even installed: on a bare machine this is a guaranteed
    // 1.5s of nothing, and the first screen a beginner sees should not idle for it.
    present.has("ollama")
      ? ai.listInstalledModels(root, { timeoutMs: 2500 }).catch(() => undefined)
      : Promise.resolve(undefined),
    localMemorySnapshot().catch(() => null),
  ]);

  const runnerUp = census.length > 0;
  return {
    platform: process.platform,
    manager: detectManager(),
    present,
    runnerUp,
    // Undefined when we could not ask; 0 only when the runner answered with an empty list.
    ...(models !== undefined ? { modelCount: models.length } : {}),
    cloudConfigured: cloudConfigured(env),
    ...(mem ? { availableBytes: Math.max(0, mem.availableBytes - mem.headroomBytes) } : {}),
    ...(nodeMajor() !== undefined ? { nodeMajor: nodeMajor() as number } : {}),
  };
}
