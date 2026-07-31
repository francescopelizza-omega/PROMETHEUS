/**
 * agents/sandbox.ts — tool-ref parsing + the §4.4 FS/sandbox guards (PURE).
 *
 * The orchestrator runs in the Electron main/utility process; FS access is wrapped
 * in a path-canonicalizing guard (resolve symlinks, reject `..` escapes, glob match).
 * SYMLINK resolution is a runtime (fs.realpath) concern done by the host at dispatch
 * time; this module owns the PURE, testable half: lexical normalization, `..`-escape
 * rejection, glob allowlist matching (with `${workspace}` expansion), and the
 * subagent sandbox-narrowing rule (child ⊆ parent, never broader).
 */
import type { AgentSandbox } from "./types.js";

/* ── tool-ref parsing ────────────────────────────────────────────────────────── */

export type ToolRefKind = "mcp" | "engine" | "ext";

export interface ParsedToolRef {
  kind: ToolRefKind;
  /** MCP server id (kind="mcp"). */
  serverId?: string;
  /** extension id (kind="ext"). */
  extId?: string;
  /** the tool / command name. */
  tool: string;
  raw: string;
}

/**
 * Parse a grant ref: "engine:<cmd>" | "ext:<extId>:<cmd>" | "<serverId>:<toolName>".
 * Returns null for a malformed ref (no ':' or empty parts).
 */
export function parseToolRef(ref: string): ParsedToolRef | null {
  const parts = ref.split(":");
  if (parts.length < 2 || parts.some((p) => p.length === 0)) return null;
  if (parts[0] === "engine") {
    return { kind: "engine", tool: parts.slice(1).join(":"), raw: ref };
  }
  if (parts[0] === "ext") {
    if (parts.length < 3) return null;
    return { kind: "ext", extId: parts[1], tool: parts.slice(2).join(":"), raw: ref };
  }
  return { kind: "mcp", serverId: parts[0], tool: parts.slice(1).join(":"), raw: ref };
}

/* ── path normalization + glob ──────────────────────────────────────────────── */

/** Lexically normalize a POSIX-ish path: collapse `//`, resolve `.`/`..`, drop trailing `/`. */
export function normalizePath(p: string): string {
  const isAbs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
      // an absolute path cannot escape root via `..` — drop it
    } else {
      out.push(seg);
    }
  }
  return (isAbs ? "/" : "") + out.join("/");
}

/** Expand the `${workspace}` token in a glob against the workspace root. */
export function expandWorkspace(pattern: string, workspaceRoot: string): string {
  return pattern.replaceAll("${workspace}", workspaceRoot.replace(/\/$/, ""));
}

/** Compile a glob (`*` = one segment, `**` = any depth) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume the second '*'
        if (glob[i + 1] === "/") {
          // `**/` → zero or more leading directory segments.
          i++;
          re += "(?:.*/)?";
        } else {
          // trailing `**` → anything, including nested slashes.
          re += ".*";
        }
      } else {
        re += "[^/]*"; // `*` → one segment
      }
    } else if (".+^${}()|[]\\".includes(c as string)) {
      re += `\\${c}`;
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True if `path` matches `glob` (segment-aware). */
export function globMatch(glob: string, path: string): boolean {
  return globToRegExp(normalizePath(glob)).test(normalizePath(path));
}

/**
 * Is `path` allowed by an allowlist of globs (with `${workspace}` expansion)? A path
 * that normalizes to an `..`-escape (relative escape above root) is ALWAYS rejected.
 */
export function isPathAllowed(path: string, allow: string[], workspaceRoot: string): boolean {
  const norm = normalizePath(path);
  if (norm.startsWith("..")) return false; // escapes the relative root
  return allow.some((g) => globMatch(expandWorkspace(g, workspaceRoot), norm));
}

/* ── subagent sandbox narrowing (child ⊆ parent — never broader) ─────────────── */

const NET_RANK: Record<AgentSandbox["network"], number> = { none: 0, "mcp-only": 1, allow: 2 };

/** Every pattern in `child` must also appear in `parent` (conservative subset). */
function patternsSubset(child: string[], parent: string[]): boolean {
  const set = new Set(parent);
  return child.every((p) => set.has(p));
}

/** Is `child` a sandbox no broader than `parent` in every dimension (§4.2)? */
export function sandboxWithin(child: AgentSandbox, parent: AgentSandbox): boolean {
  return (
    patternsSubset(child.fsRead, parent.fsRead) &&
    patternsSubset(child.fsWrite, parent.fsWrite) &&
    NET_RANK[child.network] <= NET_RANK[parent.network] &&
    (!child.shell || parent.shell) &&
    child.timeoutSec <= parent.timeoutSec
  );
}

/** Intersect a requested child sandbox with the parent so it can NEVER exceed it. */
export function narrowSandbox(parent: AgentSandbox, requested: AgentSandbox): AgentSandbox {
  const parentRead = new Set(parent.fsRead);
  const parentWrite = new Set(parent.fsWrite);
  return {
    fsRead: requested.fsRead.filter((p) => parentRead.has(p)),
    fsWrite: requested.fsWrite.filter((p) => parentWrite.has(p)),
    network:
      NET_RANK[requested.network] <= NET_RANK[parent.network] ? requested.network : parent.network,
    shell: requested.shell && parent.shell,
    timeoutSec: Math.min(requested.timeoutSec, parent.timeoutSec),
  };
}
