import type {
  InstallEvent,
  InstallRequest as InstallRequestEcho,
  InstallResult,
  InstallResults,
  InstallScope,
  InstallSummary,
} from "../contract.js";
/**
 * types/install.ts — the install/uninstall typed surface (file 02 §3.3).
 *
 * RECONCILE, DON'T DUPLICATE: the install/uninstall ENVELOPE shape already lives,
 * ground-truthed against `_install_events_json`, in ../contract.ts. We re-export
 * the ONE definition (InstallEnvelope / InstallEvent / InstallResult / etc.) here
 * so file 02's `types/install.ts` import site resolves to the same type. We then
 * ADD only what contract.ts does not carry:
 *   - a `command` literal narrowing for the discriminated union, and
 *   - InstallEvent[] as a streaming-event alias (file 02 calls these InstallEvent
 *     too; the wire row IS the event — there is no separate JSON-lines stream).
 *
 * GROUND TRUTH (probed `--json --dry-run install caveman` @ 0.15.0, blocked):
 *   {"command":"install","ok":false,
 *    "request":{"plugin":"caveman","dry_run":true,"target_agents":[...]},
 *    "results":{"install_events":[{"plugin","agent","scope","method",
 *                                  "result":"blocked"}],
 *               "summary":{"blocked":1}},
 *    "_exit":1}
 */
import type { EnvelopeBase } from "./envelope.js";

// Re-export the canonical install wire types (single source of truth, contract.ts).
export type {
  InstallEvent,
  InstallRequestEcho,
  InstallResult,
  InstallResults,
  InstallScope,
  InstallSummary,
};

/**
 * The install/uninstall envelope, with the `command` literal pinned so it slots
 * into the discriminated `Envelope` union. Payload is identical to contract.ts's
 * InstallEnvelope; we re-narrow `command` to the two literals the engine emits.
 * `forced_danger?` is inherited from EnvelopeBase (set when --force overrode a
 * nemesis BLOCK; `ok` is forced false alongside it).
 */
export type InstallEnvelope = EnvelopeBase<{
  command: "install" | "uninstall";
  request: InstallRequestEcho;
  results: InstallResults;
}>;
