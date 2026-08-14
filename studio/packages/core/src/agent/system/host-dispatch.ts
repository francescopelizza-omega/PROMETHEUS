/**
 * agent/system/host-dispatch.ts — the ONE list of tools a host's system-tool channel can run.
 *
 * WHY THIS FILE EXISTS. Dispatching a tool from the desktop pane costs a membership check in
 * the RENDERER (before the IPC call) and another in MAIN (before running it), and the two were
 * kept in step by hand. They fell out of step immediately: main was widened for the Tier-W
 * mutators and the renderer was not, so `delete_file` was advertised to the model, approved by
 * the human, and then refused by the renderer with `not available in the editor` — a tool that
 * looked present and could never run.
 *
 * That is not a bug to fix once; it is a bug that recurs every time a tool is added, because
 * the two checks encode the same fact in two places. So both now check membership of THIS
 * list, and adding a tool here is what makes it dispatchable — in both processes at once.
 *
 * PURE (definitions only, no node), so the C5-sandboxed renderer can import it and reach the
 * same conclusion main will.
 */
import { BROWSER_TOOLS } from "../browser.js";
import { WEB_SEARCH_TOOL } from "../search.js";
import type { ToolDef } from "../tools.js";
import { WEB_FETCH_TOOL } from "../web.js";

import { SYSTEM_FS_WRITE_TOOLS } from "./fs-mutate.js";
import { SYSTEM_MEMORY_TOOLS } from "./memory.js";
import { SYSTEM_TOOLS } from "./tools.js";

/**
 * Every tool a host can execute through its system-tool channel.
 *
 * Tier R (read + run_command + jobs) and Tier W (the file mutators) go to `runSystemTool`; the
 * two web tools go to `runWebTool` and out through the fail-closed L6 proxy; the three browser
 * tools go to `runBrowserTool`, out through the SAME proxy for `browser_navigate` and through a
 * host-injected browser session for the other two. What they share — the property this list
 * actually encodes — is that they are implemented in core's HOST half and therefore need a node
 * process to run in. Tools dispatched inside the renderer itself (`propose_edit`, `write_file`,
 * `apply_patch`, the todo pair) are deliberately absent.
 *
 * The browser tools are DESKTOP-only in practice — the CLI has no browser to drive — but that
 * is enforced by the CLI simply never wiring a `BrowserHostDeps` seam, not by keeping them out
 * of this shared list. A host with nothing to dispatch a name to never advertises it either way
 * (`AGENT_PANE_ALLOW` / `EDITOR_TOOLS`, desktop-only, is what actually offers them to a model).
 */
export const HOST_DISPATCH_TOOLS: readonly ToolDef[] = [
  ...SYSTEM_TOOLS,
  ...SYSTEM_FS_WRITE_TOOLS,
  ...SYSTEM_MEMORY_TOOLS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  ...BROWSER_TOOLS,
];

// Re-exported from here so a sandboxed renderer can name the web/browser tools without pulling
// in core's root barrel (which is node-tainted). They are declared in `agent/web.ts`,
// `agent/search.ts` and `agent/browser.ts`; this is a pointer, not a second definition.
export { WEB_FETCH_TOOL, WEB_SEARCH_TOOL };
export {
  BROWSER_TOOLS,
  BROWSER_NAVIGATE_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_EXTRACT_TEXT_TOOL,
} from "../browser.js";

const HOST_DISPATCH_NAMES: ReadonlySet<string> = new Set(HOST_DISPATCH_TOOLS.map((t) => t.name));

/** Whether a host's system-tool channel can run this tool. */
export function isHostDispatchTool(name: string): boolean {
  return HOST_DISPATCH_NAMES.has(name);
}
