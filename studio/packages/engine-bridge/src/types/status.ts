/**
 * types/status.ts — the `status <name>` / `status all` envelope (file 02 §3.3).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json status all` @ 0.15.0):
 *   {"command":"status","ok":true,
 *    "plugins":[{"name","tier",
 *      "agents":[{"name","method","installed":bool,
 *                 "marketplace_present":bool}],
 *      "components":[{"name","kind","state"}]}]}
 * `status all` returns every plugin; `status <name>` returns the same shape with
 * a single-element plugins[]. component.state is e.g. "absent" | "present" | ….
 */
import type { EnvelopeBase } from "./envelope.js";
import type { CatalogTier } from "./list.js";

/** Per-agent install/marketplace state for one plugin. */
export interface StatusAgent {
  name: string;
  method: string;
  installed: boolean;
  marketplace_present: boolean;
}

/** One sub-plugin/component's presence state. */
export interface StatusComponent {
  name: string;
  kind: string;
  /** "absent" | "present" | … — left open for engine-defined states. */
  state: string;
}

/** One plugin's status across its targeted agents + components. */
export interface StatusPlugin {
  name: string;
  tier: CatalogTier;
  agents: StatusAgent[];
  components: StatusComponent[];
}

export type StatusEnvelope = EnvelopeBase<{
  command: "status";
  plugins: StatusPlugin[];
}>;
