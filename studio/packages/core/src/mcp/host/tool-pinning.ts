/**
 * mcp/host/tool-pinning.ts — detect an MCP server's tool descriptors changing after approval.
 *
 * A server is nemesis-gated once, at add time (`manager.ts`'s `addServer`) — that gates the
 * LAUNCH COMMAND, not what the server claims its tools do. Nothing stopped a server from
 * silently redefining a tool's description (or its annotations, e.g. claiming `readOnlyHint` it
 * doesn't deserve) on any LATER connection: `tools/list` is re-fetched and its result
 * unconditionally trusted every time. This is the "rug pull" pattern MCP-Scan's tool pinning
 * exists to catch.
 *
 * `manager.ts`'s `connect()` hashes the tool descriptor set on every connection and compares it
 * to the hash pinned at the last clean connect; a mismatch blocks the server (the same
 * fail-closed posture `addServer` already uses for a bad launch command) rather than silently
 * trusting whatever the server now claims. `scanToolDescriptors` below is informational only —
 * it does not decide whether to block (ANY drift blocks, scan-clean or not: a server that
 * redefines itself after approval does not get to argue its own new definition is safe) — it
 * exists so the audit trail records WHY a drift looked more or less alarming.
 */
import { createHash } from "node:crypto";

import { scanForInjectionSignals } from "../../agent/protocol/injection-scan.js";
import type { McpToolDescriptor } from "./types.js";

/**
 * `JSON.stringify` alone serializes object keys in INSERTION order, not a canonical one — two
 * calls describing the identical `inputSchema`/`annotations` could legitimately stringify with
 * different key order (a server rebuilding the object dynamically, or a JSON library upgrade),
 * which would hash as a "rug pull" that never happened. Sorting keys at every nesting level
 * (arrays keep their own order — position there is usually meaningful) makes the hash depend
 * only on the actual data, not on how a particular server's serializer happened to visit it.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/** Stable, order-independent hash of a tool descriptor set. */
export function hashToolDescriptors(tools: readonly McpToolDescriptor[]): string {
  const sorted = [...tools]
    .map((t) =>
      stableStringify([
        t.name,
        t.title ?? null,
        t.description ?? null,
        t.inputSchema ?? null,
        t.annotations ?? null,
      ]),
    )
    .sort();
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

export interface ToolDriftScan {
  flagged: boolean;
  signals: string[];
}

/**
 * Pattern-scan a tool descriptor set's own text — informational, see the module doc comment.
 *
 * Includes `inputSchema`/`annotations`, not just name/title/description: a rug-pull that hides
 * its injection text inside a JSON-Schema property description or enum value would otherwise
 * still get blocked (the hash comparison doesn't care where the change is) but the audit trail
 * would under-report WHY, missing exactly the detail a reviewer needs.
 */
export function scanToolDescriptors(tools: readonly McpToolDescriptor[]): ToolDriftScan {
  const signals = new Set<string>();
  for (const t of tools) {
    const text = [
      t.name,
      t.title ?? "",
      t.description ?? "",
      t.inputSchema ? JSON.stringify(t.inputSchema) : "",
      t.annotations ? JSON.stringify(t.annotations) : "",
    ].join("\n");
    const scan = scanForInjectionSignals(text);
    for (const s of scan.signals) signals.add(s);
  }
  return { flagged: signals.size > 0, signals: [...signals] };
}
