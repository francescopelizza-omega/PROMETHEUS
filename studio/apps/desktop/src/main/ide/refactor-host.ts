/**
 * main/ide/refactor-host.ts — the `ide:refactor` verb marshaller (APP-026).
 *
 * PURE argv building + envelope mapping for the refactor.py sidecar (S025). The
 * spawn itself stays in @prometheus/engine-bridge's fail-closed `runSidecar`
 * (missing script / timeout / bad stdout → ok:false envelope — never a throw);
 * ide-ipc.ts wires the two together and tests inject a fake runner here.
 *
 * Option-injection stance: every user-supplied string travels in `--opt VALUE`
 * form (refactor.py's opt_value reads the value token verbatim, so a value can
 * never be parsed as a flag), and the zod seam has already constrained names to
 * strict identifiers and paths to traversal-free absolutes — this builder only
 * accepts a validated `RefactorRequest`, never raw renderer input.
 *
 * The WorkspaceEdit is passed through VERBATIM (no reshaping, no re-stringify):
 * the renderer's normalizeWorkspaceEdit (text-edit-apply.ts) is the single
 * tolerant parser; double-normalizing here would hide sidecar contract drift.
 */

import type { IdeRefactorResult } from "../../shared/ipc-contract.js";
import type { RefactorRequest } from "../ide-validate.js";
import { assertNotSensitivePath, uriToFsPath } from "./path-guard.js";

/** The engine-bridge runSidecar surface this host needs (injectable in tests). */
export type RefactorRunner = (
  script: "refactor.py",
  argv: string[],
) => Promise<Record<string, unknown>>;

/** Build the refactor.py argv for a VALIDATED request. Array form only — the
 *  runner spawns with shell:false, argv passed verbatim. */
export function buildRefactorArgv(req: RefactorRequest): string[] {
  const root = "root" in req && req.root !== undefined ? ["--root", req.root] : [];
  switch (req.transform) {
    case "rename":
      return [
        "rename",
        "--file",
        req.file,
        "--line",
        String(req.line),
        "--col",
        String(req.col),
        "--new-name",
        req.newName,
        ...root,
      ];
    case "extract":
      return [
        "extract",
        "--file",
        req.file,
        "--start-line",
        String(req.startLine),
        "--end-line",
        String(req.endLine),
        "--name",
        req.name,
        ...(req.kind !== undefined ? ["--kind", req.kind] : []),
        ...(req.startCol !== undefined ? ["--start-col", String(req.startCol)] : []),
        ...(req.endCol !== undefined ? ["--end-col", String(req.endCol)] : []),
        ...root,
      ];
    case "inline":
      return [
        "inline",
        "--file",
        req.file,
        "--line",
        String(req.line),
        "--col",
        String(req.col),
        ...root,
      ];
    case "move":
      return ["move", "--file", req.file, "--symbol", req.symbol, "--dest", req.dest, ...root];
    case "change-signature":
      return [
        "change-signature",
        "--file",
        req.file,
        "--line",
        String(req.line),
        "--col",
        String(req.col),
        "--order",
        req.order.join(","),
        ...(req.remove !== undefined ? ["--remove", String(req.remove)] : []),
        ...root,
      ];
    case "safe-delete":
      return [
        "safe-delete",
        "--file",
        req.file,
        "--line",
        String(req.line),
        "--col",
        String(req.col),
        ...root,
      ];
    // gen-* generators (APP-028) — single-file, no --root; attrs joined with "," is
    // safe because the zod seam pinned every entry to a strict PY_IDENT.
    case "gen-init":
    case "gen-repr":
    case "gen-eq":
      return [
        req.transform,
        "--file",
        req.file,
        "--line",
        String(req.line),
        ...(req.attrs !== undefined ? ["--attrs", req.attrs.join(",")] : []),
      ];
    case "gen-dataclass":
    case "gen-docstring":
      return [req.transform, "--file", req.file, "--line", String(req.line)];
    case "gen-property":
      return ["gen-property", "--file", req.file, "--line", String(req.line), "--attr", req.attr];
    case "gen-override":
      return [
        "gen-override",
        "--file",
        req.file,
        "--line",
        String(req.line),
        "--method",
        req.method,
      ];
    case "gen-delegate":
      return [
        "gen-delegate",
        "--file",
        req.file,
        "--line",
        String(req.line),
        "--attr",
        req.attr,
        "--method",
        req.method,
      ];
  }
}

/**
 * Editor tabs speak `file:///abs` URIs but refactor.py argv wants fs paths —
 * translate every path-bearing field (same uriToFsPath as the fs IPC) and run
 * the sensitive-path denylist over each (defence-in-depth: a refactor must not
 * become a read primitive over ~/.ssh via a hostile --root).
 */
export function normalizeRefactorPaths(req: RefactorRequest): RefactorRequest {
  const norm = (p: string): string => {
    const fsPath = uriToFsPath(p);
    assertNotSensitivePath(fsPath);
    return fsPath;
  };
  const out: RefactorRequest = { ...req, file: norm(req.file) };
  if ("root" in out && out.root !== undefined) out.root = norm(out.root);
  if (out.transform === "move") out.dest = norm(out.dest);
  return out;
}

/** Map the sidecar's one-JSON-object envelope to IdeRefactorResult. The `edit`
 *  object is the SAME reference the runner parsed — untouched (deliverable 4).
 *  `ok` must be literally true (a malformed envelope is a failure, C5), and the
 *  convenience arrays are shape-checked rather than cast. */
export function toRefactorResult(env: Record<string, unknown>): IdeRefactorResult {
  const out: IdeRefactorResult = { ok: env.ok === true };
  if (env.edit !== undefined) out.edit = env.edit;
  if (Array.isArray(env.files) && env.files.every((f) => typeof f === "string")) {
    out.files = env.files as string[];
  }
  if (typeof env.error === "string") out.error = env.error;
  if (typeof env.code === "string") out.code = env.code;
  if (Array.isArray(env.usages)) {
    const usages = env.usages.filter(
      (u): u is { uri: string; line: number } =>
        !!u &&
        typeof u === "object" &&
        typeof (u as { uri?: unknown }).uri === "string" &&
        typeof (u as { line?: unknown }).line === "number",
    );
    if (usages.length === env.usages.length) out.usages = usages;
  }
  return out;
}

/** The full verb: validated request → path normalize → argv → sidecar → result.
 *  Any throw (sensitive path, unexpected runner rejection) still lands as
 *  ok:false, never a throw across the IPC boundary. */
export async function runRefactorVerb(
  req: RefactorRequest,
  run: RefactorRunner,
): Promise<IdeRefactorResult> {
  try {
    return toRefactorResult(
      await run("refactor.py", buildRefactorArgv(normalizeRefactorPaths(req))),
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
