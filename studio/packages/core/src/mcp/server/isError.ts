/**
 * mcp/server/isError.ts — the MCP result error policy (file 09 §1.1 / §3).
 *
 * Port of `prometheus_plugin/mcp-server/src/server.ts::computeIsError`. Decides
 * whether a tool result is signalled as an MCP *error* (vs informational data):
 *
 *   1. an engine error envelope (`data.error` truthy)        → error
 *   2. prometheus_audit with worst_verdict high|critical     → error
 *      (medium / low / clean are INFORMATIONAL, not errors)
 *   3. a state-change tool that returned ok:false            → error
 *   4. otherwise                                             → not an error
 *
 * The GUI's verdict chips reuse this verbatim (file 09 §6): the chip color is a
 * direct read of `worst_verdict`, and a high/critical audit is the loud tier.
 */

/** Verdict severities the engine emits in `worst_verdict`. */
export type WorstVerdict =
  | "clean"
  | "allow"
  | "low"
  | "medium"
  | "warn"
  | "high"
  | "critical"
  | "block"
  | "error";

const ERROR_VERDICTS = new Set<string>(["high", "critical", "block", "error"]);

/**
 * Classify a tool result. `data` is the engine envelope's `data` object (or the
 * whole envelope — both `data.error`/`data.ok` and a top-level error are checked).
 */
export function computeIsError(
  toolName: string,
  data: Record<string, unknown> | undefined,
): boolean {
  if (!data) return false;
  // 1. an engine error envelope.
  if (data.error) return true;
  // 2. an audit verdict: high/critical (and block/error) are the loud tier.
  if (toolName === "prometheus_audit") {
    const worst = typeof data.worst_verdict === "string" ? data.worst_verdict : undefined;
    return worst !== undefined && ERROR_VERDICTS.has(worst);
  }
  // 3. a state-change that failed/blocked.
  if (data.ok === false) return true;
  return false;
}
