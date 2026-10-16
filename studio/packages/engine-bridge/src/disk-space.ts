// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * disk-space.ts — the typed facade over the `disk_map.py` sidecar (disk space).
 *
 * One method per verb (`python/sidecar/CONTRACT.md` § disk_map.py). The sidecar measures
 * with the vendored `python/tools/disk_space.py` and never runs as root; root work comes back
 * as an argv (`privilegedRescan`, `cleanupPlan`) for the privileged gate, which asks a human.
 *
 * Two disciplines live here rather than in every caller:
 *  - **Paths always follow `--`.** A folder named `-rf` is a path, never an option.
 *  - **A plan is never a delete.** `deletePlan` cannot send `--confirm`; only `deleteConfirm`
 *    does, and `--ack-high-risk` only when the caller says the human typed the confirmation.
 *
 * Whole-disk scans take minutes, so the measuring verbs default to a 30-minute timeout and
 * stream the sidecar's `progress:` lines through `onStderr`.
 */
import { join } from "node:path";
import { defaultPythonBin } from "./config.js";
import {
  type SidecarEnvelope,
  type SidecarOptions,
  resolveSidecarDir,
  runSidecar,
} from "./sidecar-runner.js";

export interface DiskMount {
  source: string;
  target: string;
  fstype: string;
  total: number;
  used: number;
  free: number;
  usePct: number;
  disk?: string;
  onOsDisk?: boolean;
}

/** A path as the sidecar reports it: `rawPath` (`hex:`) is the exact form when not UTF-8. */
export interface DiskPathRef {
  path: string;
  rawPath?: string;
}

export interface DiskTreeNode extends DiskPathRef {
  name: string;
  size: number;
  dir: boolean;
  /** folders + files below, when the survey counted them */
  items?: number;
  mount?: boolean;
  /** not measured past this depth yet */
  frontier?: boolean;
  unreadable?: boolean;
  /** children dropped by the payload cap */
  more?: number;
  children?: DiskTreeNode[];
}

export interface DiskMapSummary {
  root: string;
  display_root?: string;
  size: number;
  phase?: string;
  engine: string;
  depth_cap?: number;
  survey_dirs: number;
  survey_files: number;
  max_depth: number;
  errors: number;
  unreadable: number;
  seconds: number;
  skipped: string[];
}

export interface DiskMountsResult extends SidecarEnvelope {
  mounts?: DiskMount[];
}

export interface DiskMapResult extends SidecarEnvelope {
  summary?: DiskMapSummary;
  tree?: DiskTreeNode;
  nodes?: number;
  truncated?: boolean;
}

export interface DiskLevelRow extends DiskPathRef {
  size: number;
}

export interface DiskLevelsResult extends SidecarEnvelope {
  root?: string;
  levels?: { depth: number; rows: DiskLevelRow[] }[];
  summary?: DiskMapSummary;
}

export interface DiskFile extends DiskPathRef {
  size: number;
  mtime: number;
}

export interface DiskFilesResult extends SidecarEnvelope {
  root?: string;
  files?: DiskFile[];
}

export type DiskDeleteMode = "trash" | "permanent";
export type DiskRisk = "SAFE" | "LOW" | "MEDIUM" | "HIGH";

export interface DiskDeleteItem extends DiskPathRef {
  mode: DiskDeleteMode;
  size: number;
  /** the walk hit its time budget: `size` is a lower bound */
  sizeAtLeast?: boolean;
  risk: DiskRisk | null;
  reason: string;
  /** why it can never be deleted, or null */
  protected: string | null;
  trashDir?: string | null;
}

export interface DiskDeleteResult extends SidecarEnvelope {
  mode?: DiskDeleteMode;
  /** a plan: nothing changed */
  planned?: boolean;
  items?: DiskDeleteItem[];
  worstRisk?: DiskRisk | null;
  total?: number;
  /** the human must type a confirmation before `deleteConfirm(…, {ackHighRisk:true})` */
  requiresPhrase?: boolean;
  note?: string;
  /** a confirmed run */
  executed?: boolean;
  results?: (DiskPathRef & { ok: boolean; msg: string })[];
  deleted?: number;
}

export interface DiskPrivilegedRescanResult extends SidecarEnvelope {
  /** the exact argv for the privileged gate (WITHOUT the elevator) */
  argv?: string[];
  script?: { path: string; size: number; sha256: string };
  cwd?: string;
  why?: string;
}

export interface DiskCleanupAction {
  id: string;
  title: string;
  risk: DiskRisk;
  needsRoot: boolean;
  needsInput: string[];
  preview: string[];
  requiresReboot: boolean;
  recommended: boolean;
  /** argv for the privileged gate, or null when the action needs input first */
  command: string[] | null;
}

export interface DiskCleanupFinding {
  id: string;
  title: string;
  category: string;
  size: number;
  reclaimable: number;
  mountpoint: string;
  risk: DiskRisk;
  summary: string;
  actions: DiskCleanupAction[];
}

export interface DiskCleanupPlanResult extends SidecarEnvelope {
  findings?: DiskCleanupFinding[];
  note?: string;
}

/** The injectable runner (defaults to the real fail-closed `runSidecar`). */
export type DiskSidecarRunner = <T extends SidecarEnvelope>(
  script: "disk_map.py",
  argv: string[],
  opts?: SidecarOptions,
) => Promise<T>;

export interface DiskSpaceClient {
  mounts(opts?: SidecarOptions): Promise<DiskMountsResult>;
  map(
    path: string,
    args?: {
      depthCap?: number;
      minSize?: string;
      minNode?: string;
      maxNodes?: number;
      engine?: "auto" | "du" | "walk";
    },
    opts?: SidecarOptions,
  ): Promise<DiskMapResult>;
  levels(
    path: string,
    args?: { depth?: number; top?: number },
    opts?: SidecarOptions,
  ): Promise<DiskLevelsResult>;
  largestFiles(
    path: string,
    args?: { top?: number },
    opts?: SidecarOptions,
  ): Promise<DiskFilesResult>;
  deletePlan(
    paths: readonly string[],
    args?: { mode?: DiskDeleteMode },
    opts?: SidecarOptions,
  ): Promise<DiskDeleteResult>;
  deleteConfirm(
    paths: readonly string[],
    args: { mode?: DiskDeleteMode; ackHighRisk?: boolean },
    opts?: SidecarOptions,
  ): Promise<DiskDeleteResult>;
  cleanupPlan(opts?: SidecarOptions): Promise<DiskCleanupPlanResult>;
  privilegedRescan(
    path: string,
    args?: { depthCap?: number; minSize?: string },
    opts?: SidecarOptions,
  ): Promise<DiskPrivilegedRescanResult>;
  /** the exact command that opens the interactive tool as root (for the gate's terminal mode) */
  privilegedExplorer(path?: string, opts?: SidecarOptions): Promise<DiskPrivilegedRescanResult>;
}

export const DISK_SCAN_TIMEOUT_MS = 30 * 60_000;

/** `["--key", value]` for each defined value, in order. */
function flags(pairs: [string, string | number | undefined][]): string[] {
  return pairs.flatMap(([k, v]) => (v === undefined ? [] : [k, String(v)]));
}

/** Build a disk-space client over an (injectable) sidecar runner and base options. */
export function createDiskSpaceClient(
  run: DiskSidecarRunner = runSidecar,
  base: SidecarOptions = {},
): DiskSpaceClient {
  const quick = (opts?: SidecarOptions): SidecarOptions => ({ ...base, ...opts });
  const long = (opts?: SidecarOptions): SidecarOptions => ({
    timeoutMs: DISK_SCAN_TIMEOUT_MS,
    ...base,
    ...opts,
  });
  return {
    mounts: (opts) => run<DiskMountsResult>("disk_map.py", ["mounts"], quick(opts)),
    map: (path, args, opts) =>
      run<DiskMapResult>(
        "disk_map.py",
        [
          "map",
          ...flags([
            ["--depth-cap", args?.depthCap],
            ["--min-size", args?.minSize],
            ["--min-node", args?.minNode],
            ["--max-nodes", args?.maxNodes],
            ["--engine", args?.engine],
          ]),
          "--",
          path,
        ],
        long(opts),
      ),
    levels: (path, args, opts) =>
      run<DiskLevelsResult>(
        "disk_map.py",
        [
          "levels",
          ...flags([
            ["--depth", args?.depth],
            ["--top", args?.top],
          ]),
          "--",
          path,
        ],
        long(opts),
      ),
    largestFiles: (path, args, opts) =>
      run<DiskFilesResult>(
        "disk_map.py",
        ["largest-files", ...flags([["--top", args?.top]]), "--", path],
        long(opts),
      ),
    deletePlan: (paths, args, opts) =>
      run<DiskDeleteResult>(
        "disk_map.py",
        ["delete", `--${args?.mode ?? "trash"}`, "--", ...paths],
        quick(opts),
      ),
    deleteConfirm: (paths, args, opts) =>
      run<DiskDeleteResult>(
        "disk_map.py",
        [
          "delete",
          `--${args.mode ?? "trash"}`,
          "--confirm",
          ...(args.ackHighRisk ? ["--ack-high-risk"] : []),
          "--",
          ...paths,
        ],
        long(opts),
      ),
    cleanupPlan: (opts) => run<DiskCleanupPlanResult>("disk_map.py", ["cleanup-plan"], long(opts)),
    privilegedRescan: (path, args, opts) =>
      run<DiskPrivilegedRescanResult>(
        "disk_map.py",
        [
          "privileged-rescan",
          ...flags([
            ["--depth-cap", args?.depthCap],
            ["--min-size", args?.minSize],
          ]),
          "--",
          path,
        ],
        quick(opts),
      ),
    privilegedExplorer: (path, opts) =>
      run<DiskPrivilegedRescanResult>(
        "disk_map.py",
        ["privileged-explorer", ...(path ? ["--", path] : [])],
        quick(opts),
      ),
  };
}

/** Where the full disk_space.py TUI and the PTY relay live: `python/tools/`, beside the sidecars. */
export interface DiskToolPaths {
  python: string;
  tool: string;
  ptyHost: string;
}

export function diskSpaceToolPaths(
  opts: { sidecarDir?: string; pythonBin?: string } = {},
): DiskToolPaths {
  const tools = join(resolveSidecarDir(opts.sidecarDir), "..", "tools");
  return {
    python: opts.pythonBin || defaultPythonBin(),
    tool: join(tools, "disk_space.py"),
    ptyHost: join(tools, "pty_host.py"),
  };
}

/**
 * The argv of the full curses TUI. `--no-sudo` ALWAYS: left to itself the tool re-executes
 * through sudo, and nothing here may elevate on its own — a root scan goes through the
 * privileged gate instead. `-I` (isolated) because `sudo prometheus disk-space` runs this as
 * ROOT with the user's HOME: root must not load the user's site-packages `.pth` files, nor let
 * the user-writable tools/ dir shadow the standard library.
 */
export function diskSpaceTuiArgv(paths: DiskToolPaths, mapPath?: string): string[] {
  return [paths.python, "-I", paths.tool, "--no-sudo", ...(mapPath ? ["--map", mapPath] : [])];
}
