/**
 * agent/protocol/contributors/index.ts — the built-in contributor registry.
 *
 * Two lists, matching the two cadences a turn actually has (see `preamble-dispatch.ts`'s module
 * doc comment on "turn-scope" vs "round-scope"):
 *
 *   - `CORE_TURN_CONTRIBUTORS`  — assembled ONCE, when a turn's thread is built. Everything
 *     here is known before round 1 starts.
 *   - `CORE_ROUND_CONTRIBUTORS` — assembled PER ROUND, once tool-transport has been decided
 *     for that round. Only the tool catalog lives here, because it is the only built-in
 *     contributor whose content depends on transport.
 *
 * A HOST adds its own contributors (steering, memory, session-start hooks, repo map,
 * token-economy — thin adapters over getters that already live on that host's session state)
 * alongside `CORE_TURN_CONTRIBUTORS` rather than editing this file — see
 * `apps/cli/src/session/agent-runtime.ts`'s `hostTurnContributors`. That is the extensibility
 * seam a future feature author uses: write one `PreambleContributor` object, register it next
 * to the host adapters (or here, if it is genuinely cross-host), done — no change to the
 * assembler, no change to any call site's control flow.
 *
 * NOT registered here, and deliberately not a `PreambleContributor` at all: the canary
 * tripwire (`agent/canary.ts`). See that module's doc comment for why.
 */
export {
  READ_ONLY_TOOL_DISCIPLINE,
  toolDisciplineContributor,
  toolDisciplineText,
} from "./tool-discipline.js";
export {
  FLIGHT_CHECK_LOCAL_SUFFIX,
  FLIGHT_CHECK_TEXT,
  flightCheckText,
  preWriteRecheckContributor,
} from "./pre-write-recheck.js";
export { effortText, effortTextContributor } from "./effort-text.js";
export { toolCatalogContributor } from "./tool-catalog.js";
export { hostToolsContributor } from "./host-tools.js";

import type { PreambleContributor } from "../preamble-dispatch.js";
import { effortTextContributor } from "./effort-text.js";
import { hostToolsContributor } from "./host-tools.js";
import { preWriteRecheckContributor } from "./pre-write-recheck.js";
import { toolCatalogContributor } from "./tool-catalog.js";
import { toolDisciplineContributor } from "./tool-discipline.js";

export const CORE_TURN_CONTRIBUTORS: readonly PreambleContributor[] = [
  toolDisciplineContributor,
  preWriteRecheckContributor,
  effortTextContributor,
  // Environment reference data, like the repo map. Fires only when the host probed and passed
  // a manifest in, so a host that has not wired it is simply unaffected.
  hostToolsContributor,
];

export const CORE_ROUND_CONTRIBUTORS: readonly PreambleContributor[] = [toolCatalogContributor];
