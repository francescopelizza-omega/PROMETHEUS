// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/model-admission-gate.ts — will this model fit, before Studio asks a runner to load it?
 *
 * ## What was missing
 *
 * Nothing in the desktop asked. `admitModelLoad`, `affordableModels`, `inventoryCandidates`,
 * `remoteMemorySnapshot` — every primitive core has for this question had zero callers under
 * `apps/desktop`. The refusals `runAiStream` already performs are about cloud policy, egress,
 * authorisation, spend and token count; none is about memory. So a user could pick a model
 * larger than their free RAM and the app would POST to `/v1/chat/completions`, which is the
 * line that actually allocates.
 *
 * On Apple Silicon unified memory that is the documented path to a frozen compositor
 * (CLAUDE.md §2: free RAM measured at 58.9 MB while `llama-server` went 8.67 → 16.94 GB in two
 * seconds). The machine-wide 90% ceilings already in `model-ipc.ts` and `serve-supervisor.ts`
 * do not help: they ask "is the box busy", never "does THIS model fit".
 *
 * ## Why this is not simply the CLI's gate
 *
 * The terminal's `admitEndpoint` is NOT a gate. `apps/cli/src/session/host.ts:774` fires it as
 * `void admitEndpoint(...)` AFTER `endpoint = next` has already been assigned, and a refusal
 * only skips the eager `warmupLocalModel`. The next user turn POSTs anyway and the oversized
 * model loads. Its own comment says so: "The endpoint is still adopted… the turn itself will
 * report honestly if the load then fails." Importing that shape would have imported a warning
 * with the word "gate" on it.
 *
 * That weakness is also why a latent core bug never surfaced there: Rule 1 counted
 * `models.length > 0` on a census row, and an idle LM Studio reports its whole CATALOGUE
 * through `parseOpenAiModels`. A real gate refuses every load on such a machine, forever. Core
 * now carries `ResidentServer.residencyKnown` and Rule 1 ignores rows whose residency is
 * unknown — fixed there, for both surfaces, before this file was allowed to have teeth.
 *
 * ## Cost discipline
 *
 * The check costs a `sysctl` spawn plus two HTTP probes, so it must not run per TURN. It runs
 * once per (endpoint, model) pair and the verdict is cached: a conversation pays it on the
 * first message and on each model switch, which is the same frequency the terminal pays for
 * its warm-up. A cache miss on an unchanged model would put a process spawn on every message.
 *
 * ## Fail-open, deliberately
 *
 * Any error — probe timeout, no geometry, an uninstalled model — allows the load. This gate
 * exists to catch a model that is *known* not to fit; it must never become the reason a
 * legitimate turn cannot run. That matches the terminal's documented stance ("Could not
 * measure ⇒ do not stand in the way") and is the only safe default for a check this new.
 */
import { ai } from "@prometheus/core";
import { localMemorySnapshot, runnerCensus } from "@prometheus/engine-bridge";

/** What the gate concluded. `allow:false` carries prose a user can act on. */
export interface AdmissionGateResult {
  allow: boolean;
  /** the refusal, already rendered to lines; empty when allowed. */
  lines: string[];
  /** advisory notes on an ALLOWED load (an eviction, or an uncertain figure). */
  notes: string[];
}

const ALLOW: AdmissionGateResult = { allow: true, lines: [], notes: [] };

/** Probe budgets. Local only — the desktop has no remote-host concept today. */
const CENSUS_TIMEOUT_MS = 1_500;
const INVENTORY_TIMEOUT_MS = 2_500;

/**
 * Verdicts already reached, keyed `baseUrl\u0000model`.
 *
 * Not TTL'd. The inputs that could change a verdict are the model, the endpoint, and free
 * memory — the first two are the key, and the third is why `reset()` exists for an explicit
 * "things have changed" signal. A TTL would reintroduce the per-turn spawn this avoids.
 */
const verdicts = new Map<string, AdmissionGateResult>();

/** Drop the cache — a model was pulled or removed, or a test needs a clean slate. */
export function resetAdmissionCache(): void {
  verdicts.clear();
}

/** How many live checks have actually run. Test seam, mirrors `probeRequestCount`. */
export function admissionCheckCount(): number {
  return checks;
}
let checks = 0;

export interface AdmissionGateDeps {
  /** injected for tests; production uses the real probes. */
  memoryFn?: typeof localMemorySnapshot;
  censusFn?: typeof runnerCensus;
  inventoryFn?: typeof ai.inventoryCandidates;
}

/**
 * Decide whether `model` may be loaded at `baseUrl`, at `contextTokens`.
 *
 * `contextTokens` must be the window the turn will ACTUALLY be served at — the measured one
 * from `probeEndpointCapabilities`, never `DEFAULT_CONTEXT_WINDOW`. The KV cache is linear in
 * context, so passing the 8192 floor for a model that will be served at 262144 under-counts
 * the footprint by up to 32x and the gate waves through exactly the load it exists to stop.
 */
export async function admitDesktopModelLoad(
  baseUrl: string,
  model: string,
  contextTokens: number,
  deps: AdmissionGateDeps = {},
): Promise<AdmissionGateResult> {
  const key = `${baseUrl}\u0000${model}`;
  const hit = verdicts.get(key);
  if (hit) return hit;

  const memoryFn = deps.memoryFn ?? localMemorySnapshot;
  const censusFn = deps.censusFn ?? runnerCensus;
  const inventoryFn = deps.inventoryFn ?? ai.inventoryCandidates;

  checks += 1;
  let result: AdmissionGateResult;
  try {
    const runner = ai.runnerForBaseUrl(baseUrl)?.id;
    const ollamaRoot = ai.ollamaRoot(baseUrl);
    const [snapshot, census] = await Promise.all([
      // `localMemorySnapshot` takes no timeout — it is a bounded `sysctl`/`vm_stat` read, not a
      // network call. Its cost is the SPAWN, which is why this gate is cached per model rather
      // than run per turn.
      memoryFn({}),
      // Only the runners this endpoint could collide with, and ollama is the only one whose
      // residency we can actually read. LM Studio is probed too so the one-server rule can see
      // it — but `residencyKnown:false` keeps a mere catalogue from blocking anything.
      censusFn(
        [
          { id: "ollama", baseUrl: ollamaRoot, api: "ollama" as const },
          ...(runner === "lmstudio"
            ? []
            : [
                {
                  id: "lmstudio",
                  baseUrl: baseUrl.replace(/:\d+.*$/, ":1234"),
                  api: "openai" as const,
                },
              ]),
        ],
        { timeoutMs: CENSUS_TIMEOUT_MS },
      ),
    ]);

    const resident = census.flatMap((s) => s.models);
    const candidates = await inventoryFn(baseUrl, contextTokens, {
      ...(runner ? { runner } : {}),
      resident,
      timeoutMs: INVENTORY_TIMEOUT_MS,
    });

    const candidate = candidates.find((c) => c.id === model);
    // Not installed here, or `/api/tags` did not answer: there is nothing to weigh, so there is
    // nothing to refuse. Identical reasoning to the terminal's `weightsBytes <= 0` branch.
    if (!candidate || candidate.weightsBytes <= 0) {
      result = ALLOW;
    } else {
      const decision = ai.admitModelLoad({
        candidate,
        budget: {
          totalBytes: snapshot.totalBytes,
          availableBytes: snapshot.availableBytes,
          headroomBytes: snapshot.headroomBytes,
        },
        resident: census.map((s) => ({
          runner: s.runner,
          models: s.models,
          residencyKnown: s.residencyKnown,
        })),
        alternatives: candidates,
      });
      result = decision.ok
        ? {
            allow: true,
            lines: [],
            notes: [
              ...(decision.evicting?.length
                ? [`unloading ${decision.evicting.join(", ")} to make room for ${model}`]
                : []),
              ...(decision.uncertain ? [decision.uncertain] : []),
            ],
          }
        : { allow: false, lines: ai.renderRefusal(decision), notes: [] };
    }
  } catch {
    // See the header: a gate that cannot measure must not stand in the way.
    result = ALLOW;
  }

  verdicts.set(key, result);
  return result;
}
