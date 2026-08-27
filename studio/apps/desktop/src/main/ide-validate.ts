/**
 * main/ide-validate.ts — the ZOD validation seam for the IDE IPC (file 07 §3.2).
 *
 * Mirrors validate.ts / security-validate.ts / env-validate.ts exactly: every
 * renderer-supplied argument to an `ide:*` channel is parsed by a zod schema
 * BEFORE ide-ipc.ts routes it to a host. The renderer is the least-trusted surface
 * (C5) and these channels drive child processes (LSP/DAP/PTY/git) + the fs, so the
 * seam is strict and fail-closed:
 *   - a malformed arg returns the SAME serializable {kind:"invalid-args",message,
 *     detail} GuardResult the rest of the IPC uses, so ide-ipc.ts branches
 *     identically and the renderer's onError fires (never a crash, never a launch
 *     of an unvalidated child).
 *
 * Pure schema code (no electron, no host): the real `zod` resolves in production
 * via electron-vite; node:test maps it to the local double (the same zod-resolver.mjs
 * the other *-validate.test.ts files use). Bounds mirror the sibling seams so the
 * surfaces cannot drift.
 */

import { type ZodTypeAny, z } from "zod";

import type { GuardResult, IpcErrorShape } from "./arg-guards.js";

/* ── leaf schemas ───────────────────────────────────────────────────────────*/

/** A filesystem path / URI (file:///… or /abs). Control-char free, bounded. */
const PATH = z
  .string()
  .trim()
  .min(1, "path must not be empty")
  .max(4096, "path is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f]*$/, "path contains control characters");

/** A languageId (python/typescript/…). Conservative charset. */
const LANGUAGE_ID = z
  .string()
  .trim()
  .min(1, "languageId must not be empty")
  .max(64, "languageId is too long")
  .regex(/^[a-z0-9.+#-]+$/i, "languageId has invalid characters");

/** A host-minted server/session/pty id. Conservative charset (no shell metas). */
const HOST_ID = z
  .string()
  .trim()
  .min(1, "id must not be empty")
  .max(256, "id is too long")
  .regex(/^[A-Za-z0-9._:/@-]+$/, "id has invalid characters");

/** An LSP method / DAP command / git branch / etc. Conservative charset. */
const METHOD = z
  .string()
  .trim()
  .min(1, "method must not be empty")
  .max(128, "method is too long")
  .regex(/^[A-Za-z0-9._$/-]+$/, "method has invalid characters");

/** A git branch / stash message — looser (allows spaces) but control-char free. */
const TEXT = z
  .string()
  .max(4096, "text is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f]*$/, "text contains control characters");

/** A run-id correlation token. */
const RUN_ID = z
  .string()
  .trim()
  .min(1, "runId must not be empty when supplied")
  .max(128, "runId is too long")
  .regex(/^[A-Za-z0-9._:-]+$/, "runId has invalid characters");

/** A shell command line for `ide:exec`. Bounded; control-char free EXCEPT tab/newline/CR
 *  (a real command line may be multi-line). Dangerous PATTERNS are screened separately
 *  (exec-screen.ts) + the command is user-approved; this is the charset/bounds guard. */
const COMMAND = z
  .string()
  .trim()
  .min(1, "command must not be empty")
  .max(8192, "command is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/, "command contains control characters");

/** A git HEAD sha (hex, abbreviated or full). */
const SHA = z
  .string()
  .trim()
  .min(4, "sha is too short")
  .max(64, "sha is too long")
  .regex(/^[0-9a-fA-F]+$/, "sha must be hex");

/** A Python identifier for refactor names — strict, so `--flag`-shaped or
 *  dotted/spaced values can never reach the sidecar argv (option injection). */
const PY_IDENT = z
  .string()
  .trim()
  .min(1, "identifier must not be empty")
  .max(255, "identifier is too long")
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid Python identifier");

/** An ABSOLUTE refactor target (file:///…, /abs, or a Windows drive path) with
 *  no `..` traversal — rejected at the seam, before any spawn (defence-in-depth
 *  over the sidecar's own symlink-resolved --root containment). */
const REFACTOR_FILE = PATH.regex(
  /^(?:file:\/\/\/|\/|[A-Za-z]:[\\/])/,
  "path must be absolute",
).regex(/^(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))/, "path must not contain '..' segments");

/** A move destination — may be root-relative, but never `..` traversal and
 *  never `-`-leading (a flag-shaped dest could derail the sidecar's whole-argv
 *  option scan). */
const REFACTOR_DEST = PATH.regex(/^[^-]/, "path must not start with '-'").regex(
  /^(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))/,
  "path must not contain '..' segments",
);

/** A 1-based editor coordinate. */
const COORD = z.number().int("must be an integer").min(1, "must be >= 1");

/* ── the parse→GuardResult bridge (identical to the sibling seams) ───────────*/

function toIpcError(err: z.ZodError): IpcErrorShape {
  const first = err.issues[0];
  const message = first?.message ?? "invalid arguments";
  const path = first?.path?.join(".") ?? "";
  return path
    ? { kind: "invalid-args", message, detail: `at "${path}"` }
    : { kind: "invalid-args", message };
}

export function runSchema<S extends ZodTypeAny>(
  schema: S,
  input: unknown,
): GuardResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: toIpcError(parsed.error) };
}

function asObject(arg: unknown): Record<string, unknown> {
  return arg && typeof arg === "object" && !Array.isArray(arg)
    ? (arg as Record<string, unknown>)
    : {};
}

/* ── per-channel schemas ─────────────────────────────────────────────────────*/

export const fsReadSchema = z.object({ uri: PATH });
export const fsWriteSchema = z.object({ uri: PATH, text: z.string().max(64 * 1024 * 1024) });
export const fsTreeSchema = z.object({ dir: PATH });
export const fsWatchSchema = z.object({ root: PATH });
export const fsPathSchema = z.object({ path: PATH });
export const fsRenameSchema = z.object({ src: PATH, dest: PATH });

export const lspEnsureSchema = z.object({
  languageId: LANGUAGE_ID,
  workspaceRoot: PATH,
  interpreterPath: PATH.optional(),
});
export const lspRequestSchema = z.object({
  serverId: HOST_ID,
  workspaceRoot: PATH,
  method: METHOD,
  params: z.unknown().optional(),
});
export const lspCancelSchema = z.object({
  serverId: HOST_ID,
  workspaceRoot: PATH,
  requestId: z.number().int(),
});
export const lspDocSchema = z.object({
  serverId: HOST_ID,
  workspaceRoot: PATH,
  uri: PATH,
  languageId: LANGUAGE_ID.optional(),
  text: z
    .string()
    .max(64 * 1024 * 1024)
    .optional(),
  version: z.number().int().optional(),
});
export const lspSetInterpreterSchema = z.object({
  serverId: HOST_ID,
  workspaceRoot: PATH,
  interpreterPath: PATH,
});

/** One DAP `SourceBreakpoint` (APP-079). condition/hitCondition/logMessage are user
 *  data headed for the debug adapter — bounded in length but otherwise VERBATIM (no
 *  argv/eval handling: this is a JSON body, not a shell — there is no injection surface). */
const sourceBreakpointSchema = z.object({
  line: z.number().int().min(1),
  condition: z.string().max(4096).optional(),
  hitCondition: z.string().max(256).optional(),
  logMessage: z.string().max(4096).optional(),
});
/** One source's launch-time breakpoints (absolute path + its SourceBreakpoints). */
const dapSourcePlanSchema = z.object({
  path: PATH,
  breakpoints: z.array(sourceBreakpointSchema).max(2000),
});

/** A remote/attach connect host (APP-080): a bare hostname or IP literal (IPv6 may be
 *  bracketed) — control-char/whitespace/null free, bounded to the DNS max total of 253. */
const DAP_HOST = z
  .string()
  .trim()
  .min(1, "host must not be empty")
  .max(253, "host is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\s\u0000-\u001f]+$/, "host has whitespace or control characters");
/** A remote/attach connect port (APP-080): a real TCP port — reject 0 ("any port",
 *  not a target) and non-integers. */
const DAP_PORT = z.number().int("port must be an integer").min(1, "port must be >= 1").max(65535);

export const dapLaunchSchema = z.object({
  type: LANGUAGE_ID,
  request: z.enum(["launch", "attach"]),
  name: TEXT,
  python: PATH.optional(),
  program: PATH.optional(),
  module: METHOD.optional(),
  args: z.array(z.string().max(4096)).optional(),
  console: z.enum(["internalConsole", "integratedTerminal", "externalTerminal"]).optional(),
  runtimeArgs: z.array(z.string().max(4096)).optional(),
  cwd: PATH.optional(),
  // APP-080 remote/attach socket target — kept in the attach args verbatim (debugpy
  // client-mode `{ connect: { host, port } }`); the cross-field "attach-only" guard is
  // enforced imperatively in validateDapLaunch (kept out of a zod refine so the
  // node:test zod double stays sufficient, per the search-glob precedent).
  connect: z.object({ host: DAP_HOST, port: DAP_PORT }).optional(),
  // APP-080: the renderer's typed-confirm for a REMOTE attach — a non-DAP flag split
  // out in ide-ipc so it never reaches the adapter; the host re-checks fail-closed.
  allowRemote: z.boolean().optional(),
  // APP-079 launch-time config plan (host-sequenced initialized→config→configurationDone).
  breakpoints: z.array(dapSourcePlanSchema).max(2000).optional(),
  exceptionFilters: z.array(z.string().max(128)).max(64).optional(),
});
export const dapRequestSchema = z.object({
  sessionId: HOST_ID,
  command: METHOD,
  args: z.unknown().optional(),
});
export const dapTerminateSchema = z.object({ sessionId: HOST_ID });
export const dapDetectAdapterSchema = z.object({ type: LANGUAGE_ID, pythonPath: PATH.optional() });
export const dapInstallAdapterSchema = z.object({
  type: LANGUAGE_ID,
  pythonPath: PATH.optional(),
  confirm: z.boolean().optional(),
});

/* ── ide:refactor (APP-026) — one strict branch per refactor.py transform ────
 * discriminatedUnion (NOT plain union): O(1) branch pick + a precise
 * "invalid discriminator" rejection for unknown transforms. Every branch is
 * `.strict()` so extra keys are rejected — the argv builder must never see a
 * field this schema didn't vouch for. */
export const refactorSchema = z.discriminatedUnion("transform", [
  z
    .object({
      transform: z.literal("rename"),
      file: REFACTOR_FILE,
      line: COORD,
      col: COORD,
      newName: PY_IDENT,
      root: REFACTOR_FILE.optional(),
    })
    .strict(),
  z
    .object({
      transform: z.literal("extract"),
      file: REFACTOR_FILE,
      startLine: COORD,
      endLine: COORD,
      name: PY_IDENT,
      kind: z.enum(["method", "variable"]).optional(),
      startCol: COORD.optional(),
      endCol: COORD.optional(),
      root: REFACTOR_FILE.optional(),
    })
    .strict(),
  z
    .object({
      transform: z.literal("inline"),
      file: REFACTOR_FILE,
      line: COORD,
      col: COORD,
      root: REFACTOR_FILE.optional(),
    })
    .strict(),
  z
    .object({
      transform: z.literal("move"),
      file: REFACTOR_FILE,
      symbol: PY_IDENT,
      dest: REFACTOR_DEST,
      root: REFACTOR_FILE.optional(),
    })
    .strict(),
  z
    .object({
      transform: z.literal("change-signature"),
      file: REFACTOR_FILE,
      line: COORD,
      col: COORD,
      order: z.array(z.number().int("must be an integer").min(0, "must be >= 0")).max(64),
      remove: z.number().int("must be an integer").min(0, "must be >= 0").optional(),
      root: REFACTOR_FILE.optional(),
    })
    .strict(),
  z
    .object({
      transform: z.literal("safe-delete"),
      file: REFACTOR_FILE,
      line: COORD,
      col: COORD,
      root: REFACTOR_FILE.optional(),
    })
    .strict(),
  // ── gen-* generator verbs (APP-028) — single-file inserts, so no `root`; every
  // free-string leaf stays PY_IDENT (option-injection stance unchanged) ─────────
  z
    .object({
      transform: z.literal("gen-init"),
      file: REFACTOR_FILE,
      line: COORD,
      attrs: z.array(PY_IDENT).min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      transform: z.literal("gen-repr"),
      file: REFACTOR_FILE,
      line: COORD,
      attrs: z.array(PY_IDENT).min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      transform: z.literal("gen-eq"),
      file: REFACTOR_FILE,
      line: COORD,
      attrs: z.array(PY_IDENT).min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      transform: z.literal("gen-dataclass"),
      file: REFACTOR_FILE,
      line: COORD,
    })
    .strict(),
  z
    .object({
      transform: z.literal("gen-property"),
      file: REFACTOR_FILE,
      line: COORD,
      attr: PY_IDENT,
    })
    .strict(),
  z
    .object({
      transform: z.literal("gen-override"),
      file: REFACTOR_FILE,
      line: COORD,
      method: PY_IDENT,
    })
    .strict(),
  z
    .object({
      transform: z.literal("gen-delegate"),
      file: REFACTOR_FILE,
      line: COORD,
      attr: PY_IDENT,
      method: PY_IDENT,
    })
    .strict(),
  z
    .object({
      transform: z.literal("gen-docstring"),
      file: REFACTOR_FILE,
      line: COORD,
    })
    .strict(),
]);

/* ── ide:run (APP-032) — a resolved invocation + the gate identity ───────────
 * cmd/cwd stay PATH-shaped (no control chars); args are plain string tokens
 * (argv ARRAY — a value can never become a flag/shell fragment in the pty
 * spawn); env keys are strict idents (the loader-hijack denylist is enforced
 * again inside run-host — this seam just rejects malformed shapes). */
export const runStartSchema = z.object({
  cmd: PATH,
  args: z.array(z.string().max(4096)).max(256),
  cwd: PATH,
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192)).optional(),
  workspaceRoot: PATH,
  head: SHA.optional(),
  venv: z.object({ root: PATH, platform: z.enum(["win32", "posix"]).optional() }).nullish(),
});
export const runKillSchema = z.object({ runId: HOST_ID });

export const ptySpawnSchema = z.object({
  cwd: PATH,
  shell: PATH.optional(),
  cols: z.number().int().min(1).max(2000).optional(),
  rows: z.number().int().min(1).max(2000).optional(),
  venv: z.object({ root: PATH, platform: z.enum(["win32", "posix"]).optional() }).nullish(),
});
export const ptyWriteSchema = z.object({ ptyId: HOST_ID, data: z.string().max(1024 * 1024) });
export const ptyResizeSchema = z.object({
  ptyId: HOST_ID,
  cols: z.number().int().min(1).max(2000),
  rows: z.number().int().min(1).max(2000),
});
export const ptyKillSchema = z.object({ ptyId: HOST_ID });
// APP-090: tear-out terminal window. title is display text (control-char free, bounded);
// scheme is a conservative theme-name token (no path/metachars); ptyId is a host id.
export const floatingTerminalCreateSchema = z.object({
  ptyId: HOST_ID,
  title: z.string().trim().min(1, "title must not be empty").max(256),
  scheme: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, "scheme has invalid characters")
    .optional(),
});
export const floatingTerminalCloseSchema = z.object({ ptyId: HOST_ID });

export const gitRootSchema = z.object({ root: PATH });
export const gitDiffSchema = z.object({
  root: PATH,
  file: PATH,
  staged: z.boolean().optional().default(false),
});
export const gitFilesSchema = z.object({ root: PATH, files: z.array(PATH).max(10000) });
export const gitCommitSchema = z.object({
  root: PATH,
  message: TEXT,
  amend: z.boolean().optional().default(false),
});
export const gitBranchSchema = z.object({
  root: PATH,
  name: z
    .string()
    .trim()
    .min(1, "branch must not be empty")
    .max(255, "branch is too long")
    .regex(/^[^\s;&|`$<>(){}\\]+$/, "branch has invalid characters")
    .regex(/^[^-]/, "branch must not start with '-'"),
  create: z.boolean().optional().default(false),
});
// Task #5 (desktop parity): worktree isolation. Zod is a SECOND, redundant defense here —
// `@prometheus/core/git-worktree`'s `isSafeToken` already rejects a flag-like branch/path
// before any spawn — but the seam still validates shape at the IPC boundary like every
// other git.* channel.
export const gitWorktreeCreateSchema = z.object({
  root: PATH,
  branch: z
    .string()
    .trim()
    .min(1, "branch must not be empty")
    .max(255, "branch is too long")
    .regex(/^[^\s;&|`$<>(){}\\]+$/, "branch has invalid characters")
    .regex(/^[^-]/, "branch must not start with '-'"),
  path: PATH.optional(),
});
export const gitWorktreeRemoveSchema = z.object({ root: PATH, path: PATH });
export const gitStashSchema = z.object({ root: PATH, message: TEXT.optional() });
export const gitStashRefSchema = z.object({
  root: PATH,
  index: z.number().int().min(0).max(1000).optional(),
});
export const gitBlameSchema = z.object({ root: PATH, file: PATH });
export const gitCheckoutSideSchema = z.object({
  root: PATH,
  file: PATH,
  side: z.enum(["ours", "theirs"]),
});
/** APP-039: a repo-relative file for `git show :N:<file>` — no leading '-'/'/'
 *  (flag/absolute) and no '..' traversal (mirrors the existing git handler guards). */
export const gitConflictVersionsSchema = z.object({
  root: PATH,
  file: PATH.regex(/^[^-/]/, "file must be repo-relative (no leading '-' or '/')").regex(
    /^(?:(?!\.\.).)*$/,
    "file must not contain '..'",
  ),
});

/** APP-042: a dialect-allowlisted SQL connection string, never flag-shaped. */
const SQL_CONN = z
  .string()
  .trim()
  .min(1, "connection string is required")
  .max(4096, "connection string too long")
  .regex(/^[^-]/, "connection string must not start with '-'")
  .regex(/^(sqlite|postgres|postgresql|mysql):/i, "unsupported dialect (sqlite|postgresql|mysql)");
export const sqlConnectSchema = z.object({ conn: SQL_CONN });
export const sqlQuerySchema = z.object({
  conn: SQL_CONN,
  sql: z.string().min(1, "sql is required").max(1_048_576, "sql too large (1MB cap)"),
  params: z.array(z.unknown()).max(1000).optional(),
  page: z.number().int().min(0).max(1_000_000).optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
  timeoutS: z.number().int().min(1).max(300).optional(),
});
export const sqlSchemaSchema = z.object({ conn: SQL_CONN, table: z.string().max(256).optional() });
// ── live Jupyter kernel (APP-045) ───────────────────────────────────────────
export const kernelStartSchema = z.object({
  cwd: PATH,
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192)).optional(),
});
export const kernelExecuteSchema = z.object({
  sessionId: HOST_ID,
  cellId: HOST_ID,
  code: z.string().max(1_048_576, "code too large (1MB cap)"),
});
export const kernelSessionSchema = z.object({ sessionId: HOST_ID });
// APP-088: paged DataFrame view request. `name` is a kernel-global variable name — a
// conservative identifier (no shell/eval metacharacters; the kernel wraps it in repr).
export const kernelDataframeSchema = z.object({
  sessionId: HOST_ID,
  name: z
    .string()
    .trim()
    .min(1, "name must not be empty")
    .max(256, "name is too long")
    .regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "name has invalid characters"),
  offset: z.number().int().min(0).max(1_000_000_000).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
// ── profiler (APP-046) ───────────────────────────────────────────────────────
export const profileStartSchema = z.object({
  path: PATH,
  workspaceRoot: PATH,
  cwd: PATH.optional(),
  args: z.array(z.string().max(4096)).max(256).optional(),
  timeoutS: z.number().min(0.1).max(3600).optional(),
  head: SHA.optional(),
  // APP-089: profiling mode (default cpu applied in the validator).
  mode: z.enum(["cpu", "memory", "async"]).optional(),
});
// APP-089: a folded profile sample (a stack + a value). Bounded: the stack depth + frame
// length are capped so a hostile/huge samples blob can't blow the snapshot file / IPC.
const PROFILE_SAMPLE = z.object({
  stack: z.array(z.string().max(512)).max(256),
  value: z.number().int(),
});
// APP-089: a snapshot id — a bare stem (no separators/traversal); mirrors profile.py _valid_id.
const SNAPSHOT_ID = z
  .string()
  .trim()
  .min(1, "id must not be empty")
  .max(256, "id is too long")
  .regex(/^[A-Za-z0-9._-]+$/, "id has invalid characters");
export const profileSnapshotSaveSchema = z.object({
  name: z.string().trim().min(1, "name must not be empty").max(256),
  mode: z.enum(["cpu", "memory", "async"]),
  unit: z.string().trim().min(1).max(32),
  samples: z.array(PROFILE_SAMPLE).max(5000),
  totalValue: z.number().int(),
});
export const profileCompareSchema = z.object({ aId: SNAPSHOT_ID, bId: SNAPSHOT_ID });
// ── terminal launcher (APP-048) ──────────────────────────────────────────────
const TERMINAL_ENV = z.object({
  name: z.string().max(256),
  path: PATH,
  kind: z.string().max(64),
  pythonVersion: z.string().max(64).nullish(),
});
export const terminalMenuSchema = z.object({
  workspaceRoot: PATH,
  envs: z.array(TERMINAL_ENV).max(512).optional(),
});
// ── repo-map (APP-053) ────────────────────────────────────────────────────────
export const repoMapSchema = z.object({
  root: PATH,
  files: z.array(z.string().max(1024)).max(2000).optional(),
  budget: z.number().int().min(100).max(1_000_000).optional(),
  query: z.string().max(2048).optional(),
});
export const terminalResolveSchema = z.object({
  id: HOST_ID,
  workspaceRoot: PATH,
  envs: z.array(TERMINAL_ENV).max(512).optional(),
  activeEnvPath: PATH.nullish(),
  fileDir: PATH.optional(),
});
export const gitLogSchema = z.object({
  root: PATH,
  limit: z.number().int().min(1).max(1000).optional().default(50),
});

/** A git commit-ish / ref (APP-037): allows HEAD~1, origin/main, abc123^, hex — but
 *  never a flag-shaped (`-`-leading) or whitespace-bearing value (option-injection). */
const GIT_REF = z
  .string()
  .trim()
  .min(1, "ref must not be empty")
  .max(255, "ref is too long")
  .regex(/^[^-]/, "ref must not start with '-'")
  .regex(/^[0-9A-Za-z_/~^.-]+$/, "ref has invalid characters");
export const gitCommitRefSchema = z.object({ root: PATH, hash: GIT_REF });
export const gitResetSchema = z.object({
  root: PATH,
  hash: GIT_REF,
  mode: z.enum(["soft", "mixed", "hard"]),
});

/** APP-082 interactive rebase. A todo `sha` is STRICT lowercase hex (git shas are
 *  lowercase; this is attacker-shaped renderer input that reaches `git rebase -i`
 *  argv/todo). The `base` may be a `HEAD~N`/branch/sha (GIT_REF) — the host resolves
 *  it to a concrete sha before it hits argv. Actions are the whitelisted todo verbs. */
const REBASE_SHA = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,40}$/, "sha must be 7–40 lowercase hex chars");
const REBASE_ACTION = z.enum(["pick", "reword", "squash", "fixup", "drop"]);
const REBASE_TODO_ROW = z.object({
  sha: REBASE_SHA,
  action: REBASE_ACTION,
  subject: TEXT.optional().default(""),
  message: TEXT.optional(),
});

/** APP-085 gated PR review. A PR/MR number is a positive integer; a comment body allows
 *  newlines/tabs (multi-line markdown) but is NUL-free + size-capped; a forge token is
 *  opaque printable-ASCII (no whitespace/control) so it can never inject a flag/shell. */
export const gitPrGetSchema = z.object({
  root: PATH,
  number: z.number().int().min(1).max(100_000_000),
});
export const gitPrCommentSchema = z.object({
  root: PATH,
  number: z.number().int().min(1).max(100_000_000),
  body: z
    .string()
    .trim()
    .min(1, "comment body is empty")
    .max(65_536, "comment body is too large")
    // allow tab/newline/CR (multi-line comment), forbid NUL + other control chars.
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/, "comment has control characters"),
});
export const gitPrSetTokenSchema = z.object({
  root: PATH,
  token: z
    .string()
    .trim()
    .min(1, "token is empty")
    .max(512, "token is too long")
    .regex(/^[!-~]+$/, "token has invalid characters"),
});

/** APP-084 per-hunk staging: a caller-built patch piped to `git apply --cached -`.
 *  Opaque text, size-capped, NUL-free (a text unified diff never carries NUL; binary
 *  patches are out of scope) — it rides over STDIN, never argv, so no flag-injection. */
export const gitApplyPatchSchema = z.object({
  root: PATH,
  patch: z
    .string()
    .min(1, "patch is empty")
    .max(2_000_000, "patch is too large")
    .regex(/^[^\x00]*$/, "patch must not contain a NUL byte"),
  cached: z.boolean().optional().default(true),
  reverse: z.boolean().optional().default(false),
});
export const gitRebaseTodoSchema = z.object({ root: PATH, base: GIT_REF });
export const gitRebaseRunSchema = z.object({
  root: PATH,
  base: GIT_REF,
  todo: z.array(REBASE_TODO_ROW).min(1, "todo is empty").max(1000, "todo is too long"),
});

/** A pytest node id / unittest dotted id — never parseable as a flag (APP-013). */
const TEST_ID = z
  .string()
  .min(1, "test id must not be empty")
  .max(2048, "test id is too long")
  .regex(/^[^-]/, "test id must not start with '-'")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^;|&$`<>\\\u0000-\u001f]+$/, "test id has invalid characters");

export const testRunSchema = z.object({
  root: PATH,
  framework: z.enum(["pytest", "unittest"]),
  ids: z.array(TEST_ID).min(1, "ids must not be empty").max(1000, "too many ids"),
  /** true → the sidecar's `rerun-failed` verb (ids are the last failures). */
  rerun: z.boolean().optional(),
});

/** APP-086 coverage run: same shape as a test run but ids are OPTIONAL (empty = whole
 *  suite). Reuses the option-injection-guarded TEST_ID (no leading '-', no shell/ctrl). */
export const coverageRunSchema = z.object({
  root: PATH,
  framework: z.enum(["pytest", "unittest"]),
  ids: z.array(TEST_ID).max(2000).optional().default([]),
});
export const coverageImportSchema = z.object({ path: PATH });

export const gateSchema = z.object({
  workspaceRoot: PATH,
  head: SHA.optional(),
  runId: RUN_ID.optional(),
});

export const execSchema = z.object({ command: COMMAND, cwd: PATH });

/** A non-empty search needle (control-char free, bounded). */
const SEARCH_QUERY = z
  .string()
  .min(1, "query must not be empty")
  .max(4096, "query is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/, "query contains control characters");

/** A ROOT-RELATIVE include/exclude glob (APP-024). Charset/bounds only here —
 *  traversal (`..` segment) + absolute-path rejection is `globPatternError` below
 *  (segment-wise, so a legit filename like `foo..bar.ts` still passes). */
const GLOB = z
  .string()
  .trim()
  .min(1, "glob must not be empty")
  .max(512, "glob is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f]*$/, "glob contains control characters");

export const searchSchema = z.object({
  root: PATH,
  query: SEARCH_QUERY,
  mode: z.enum(["content", "path"]).optional(),
  extensions: z.array(LANGUAGE_ID).max(64).optional(),
  caseSensitive: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(5000).optional(),
  include: z.array(GLOB).max(32).optional(),
  exclude: z.array(GLOB).max(32).optional(),
  // APP-066: opaque correlation id for progress + cancel (never a path — no path guard).
  requestId: z.string().min(1).max(128).optional(),
});

/** APP-066: `ide:searchCancel` payload — just the opaque correlation id. */
export const searchCancelSchema = z.object({
  requestId: z.string().min(1).max(128),
});

/** APP-076: `ide:structsearch` — a workspace path + an AST pattern template (length-capped). */
export const structSearchSchema = z.object({
  root: PATH,
  pattern: z.string().min(1).max(4000),
});
export interface StructSearchArgs {
  root: string;
  pattern: string;
}
export function validateStructSearch(a: unknown): GuardResult<StructSearchArgs> {
  const r = runSchema(structSearchSchema, asObject(a));
  if (!r.ok) return r;
  return { ok: true, value: { root: r.value.root, pattern: r.value.pattern } };
}

/**
 * Reject a glob that could ESCAPE the search root (APP-024, fail-closed):
 * absolute (`/…`, `C:\…`, UNC `\\…`), home-anchored (`~…`), or containing `..`
 * as a FULL path segment. Checked on split segments — never a substring test —
 * so `a/../../etc` is caught while a filename literally containing dots like
 * `foo..bar.ts` passes. Returns the error message, or null when safe.
 */
export function globPatternError(pattern: string): string | null {
  if (pattern.startsWith("/") || pattern.startsWith("~")) return "glob must be root-relative";
  if (/^[A-Za-z]:[\\/]/.test(pattern) || pattern.startsWith("\\\\"))
    return "glob must be root-relative";
  const segments = pattern.split(/[\\/]+/);
  if (segments.some((s) => s === "..")) return "glob must not contain '..' segments";
  return null;
}

/* ── typed validators (what ide-ipc.ts calls) ───────────────────────────────*/

export function validateFsRead(a: unknown): GuardResult<{ uri: string }> {
  return runSchema(fsReadSchema, asObject(a));
}
export function validateFsWrite(a: unknown): GuardResult<{ uri: string; text: string }> {
  return runSchema(fsWriteSchema, asObject(a));
}
export function validateFsTree(a: unknown): GuardResult<{ dir: string }> {
  return runSchema(fsTreeSchema, asObject(a));
}
export function validateFsWatch(a: unknown): GuardResult<{ root: string }> {
  return runSchema(fsWatchSchema, asObject(a));
}
export function validateFsPath(a: unknown): GuardResult<{ path: string }> {
  return runSchema(fsPathSchema, asObject(a));
}
export function validateFsRename(a: unknown): GuardResult<{ src: string; dest: string }> {
  return runSchema(fsRenameSchema, asObject(a));
}

export interface LspEnsureArgs {
  languageId: string;
  workspaceRoot: string;
  interpreterPath?: string;
}
export function validateLspEnsure(a: unknown): GuardResult<LspEnsureArgs> {
  const r = runSchema(lspEnsureSchema, asObject(a));
  if (!r.ok) return r;
  const v: LspEnsureArgs = { languageId: r.value.languageId, workspaceRoot: r.value.workspaceRoot };
  if (r.value.interpreterPath !== undefined) v.interpreterPath = r.value.interpreterPath;
  return { ok: true, value: v };
}

export interface LspRequestArgs {
  serverId: string;
  workspaceRoot: string;
  method: string;
  params?: unknown;
}
export function validateLspRequest(a: unknown): GuardResult<LspRequestArgs> {
  const r = runSchema(lspRequestSchema, asObject(a));
  if (!r.ok) return r;
  const v: LspRequestArgs = {
    serverId: r.value.serverId,
    workspaceRoot: r.value.workspaceRoot,
    method: r.value.method,
  };
  if (r.value.params !== undefined) v.params = r.value.params;
  return { ok: true, value: v };
}

export function validateLspCancel(
  a: unknown,
): GuardResult<{ serverId: string; workspaceRoot: string; requestId: number }> {
  return runSchema(lspCancelSchema, asObject(a));
}

export interface LspDocArgs {
  serverId: string;
  workspaceRoot: string;
  uri: string;
  languageId?: string;
  text?: string;
  version?: number;
}
export function validateLspDoc(a: unknown): GuardResult<LspDocArgs> {
  const r = runSchema(lspDocSchema, asObject(a));
  if (!r.ok) return r;
  const v: LspDocArgs = {
    serverId: r.value.serverId,
    workspaceRoot: r.value.workspaceRoot,
    uri: r.value.uri,
  };
  if (r.value.languageId !== undefined) v.languageId = r.value.languageId;
  if (r.value.text !== undefined) v.text = r.value.text;
  if (r.value.version !== undefined) v.version = r.value.version;
  return { ok: true, value: v };
}

export function validateLspSetInterpreter(
  a: unknown,
): GuardResult<{ serverId: string; workspaceRoot: string; interpreterPath: string }> {
  return runSchema(lspSetInterpreterSchema, asObject(a));
}

/** One source's breakpoints in the validated launch plan (APP-079). */
export interface DapLaunchSourcePlan {
  path: string;
  breakpoints: { line: number; condition?: string; hitCondition?: string; logMessage?: string }[];
}
export interface DapLaunchArgs {
  type: string;
  request: "launch" | "attach";
  name: string;
  python?: string;
  program?: string;
  module?: string;
  args?: string[];
  console?: "internalConsole" | "integratedTerminal" | "externalTerminal";
  runtimeArgs?: string[];
  cwd?: string;
  /** remote/attach socket target (APP-080) — attach-request only, passed to the
   *  adapter verbatim; a REMOTE (non-loopback) connect additionally needs allowRemote. */
  connect?: { host: string; port: number };
  /** the renderer's typed-confirm for a remote attach (APP-080) — split out in ide-ipc
   *  so it never reaches the adapter; the host re-checks loopback fail-closed. */
  allowRemote?: boolean;
  /** launch-time per-source breakpoints (host-sequenced config phase, APP-079). */
  breakpoints?: DapLaunchSourcePlan[];
  /** launch-time exception breakpoint filter IDs to arm (APP-079). */
  exceptionFilters?: string[];
}
export function validateDapLaunch(a: unknown): GuardResult<DapLaunchArgs> {
  const r = runSchema(dapLaunchSchema, asObject(a));
  if (!r.ok) return r;
  const s = r.value;
  // fail-closed cross-field guard (APP-080): a `connect` target is meaningless (and a
  // remote-exec footgun) on a `launch` request — reject it here rather than in a zod
  // refine so the node:test zod double stays sufficient (the search-glob precedent).
  if (s.connect !== undefined && s.request !== "attach") {
    return {
      ok: false,
      error: { kind: "invalid-args", message: "connect is only valid for an attach request" },
    };
  }
  const v: DapLaunchArgs = { type: s.type, request: s.request, name: s.name };
  if (s.python !== undefined) v.python = s.python;
  if (s.program !== undefined) v.program = s.program;
  if (s.module !== undefined) v.module = s.module;
  if (s.args !== undefined) v.args = s.args;
  if (s.console !== undefined) v.console = s.console;
  if (s.runtimeArgs !== undefined) v.runtimeArgs = s.runtimeArgs;
  if (s.cwd !== undefined) v.cwd = s.cwd;
  if (s.connect !== undefined) v.connect = s.connect;
  if (s.allowRemote !== undefined) v.allowRemote = s.allowRemote;
  if (s.breakpoints !== undefined) v.breakpoints = s.breakpoints;
  if (s.exceptionFilters !== undefined) v.exceptionFilters = s.exceptionFilters;
  return { ok: true, value: v };
}

export interface DapRequestArgs {
  sessionId: string;
  command: string;
  args?: unknown;
}
export function validateDapRequest(a: unknown): GuardResult<DapRequestArgs> {
  const r = runSchema(dapRequestSchema, asObject(a));
  if (!r.ok) return r;
  const v: DapRequestArgs = { sessionId: r.value.sessionId, command: r.value.command };
  if (r.value.args !== undefined) v.args = r.value.args;
  return { ok: true, value: v };
}

export function validateDapTerminate(a: unknown): GuardResult<{ sessionId: string }> {
  return runSchema(dapTerminateSchema, asObject(a));
}
export interface DapDetectAdapterArgs {
  type: string;
  pythonPath?: string;
}
export function validateDapDetectAdapter(a: unknown): GuardResult<DapDetectAdapterArgs> {
  const r = runSchema(dapDetectAdapterSchema, asObject(a));
  if (!r.ok) return r;
  const v: DapDetectAdapterArgs = { type: r.value.type };
  if (r.value.pythonPath !== undefined) v.pythonPath = r.value.pythonPath;
  return { ok: true, value: v };
}

export interface DapInstallAdapterArgs {
  type: string;
  pythonPath?: string;
  confirm?: boolean;
}
export function validateDapInstallAdapter(a: unknown): GuardResult<DapInstallAdapterArgs> {
  const r = runSchema(dapInstallAdapterSchema, asObject(a));
  if (!r.ok) return r;
  const v: DapInstallAdapterArgs = { type: r.value.type };
  if (r.value.pythonPath !== undefined) v.pythonPath = r.value.pythonPath;
  if (r.value.confirm !== undefined) v.confirm = r.value.confirm;
  return { ok: true, value: v };
}

/** The validated `ide:refactor` request — one variant per refactor.py verb. */
export type RefactorRequest =
  | { transform: "rename"; file: string; line: number; col: number; newName: string; root?: string }
  | {
      transform: "extract";
      file: string;
      startLine: number;
      endLine: number;
      name: string;
      kind?: "method" | "variable";
      startCol?: number;
      endCol?: number;
      root?: string;
    }
  | { transform: "inline"; file: string; line: number; col: number; root?: string }
  | { transform: "move"; file: string; symbol: string; dest: string; root?: string }
  | {
      transform: "change-signature";
      file: string;
      line: number;
      col: number;
      order: number[];
      remove?: number;
      root?: string;
    }
  | { transform: "safe-delete"; file: string; line: number; col: number; root?: string }
  | { transform: "gen-init"; file: string; line: number; attrs?: string[] }
  | { transform: "gen-repr"; file: string; line: number; attrs?: string[] }
  | { transform: "gen-eq"; file: string; line: number; attrs?: string[] }
  | { transform: "gen-dataclass"; file: string; line: number }
  | { transform: "gen-property"; file: string; line: number; attr: string }
  | { transform: "gen-override"; file: string; line: number; method: string }
  | { transform: "gen-delegate"; file: string; line: number; attr: string; method: string }
  | { transform: "gen-docstring"; file: string; line: number };

export function validateRefactor(a: unknown): GuardResult<RefactorRequest> {
  return runSchema(refactorSchema, asObject(a)) as GuardResult<RefactorRequest>;
}

/** The validated `ide:run.start` request (APP-032). */
export interface RunStartArgs {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  workspaceRoot: string;
  head?: string;
  venv?: { root: string; platform?: "win32" | "posix" };
}
export function validateRunStart(a: unknown): GuardResult<RunStartArgs> {
  const r = runSchema(runStartSchema, asObject(a));
  if (!r.ok) return r;
  const v: RunStartArgs = {
    cmd: r.value.cmd,
    args: r.value.args,
    cwd: r.value.cwd,
    workspaceRoot: r.value.workspaceRoot,
  };
  if (r.value.env !== undefined) v.env = r.value.env;
  if (r.value.head !== undefined) v.head = r.value.head;
  if (r.value.venv !== undefined && r.value.venv !== null) v.venv = r.value.venv;
  return { ok: true, value: v };
}
export function validateRunKill(a: unknown): GuardResult<{ runId: string }> {
  return runSchema(runKillSchema, asObject(a));
}

export interface PtySpawnArgs {
  cwd: string;
  shell?: string;
  cols?: number;
  rows?: number;
  venv?: { root: string; platform?: "win32" | "posix" };
}
export function validatePtySpawn(a: unknown): GuardResult<PtySpawnArgs> {
  const r = runSchema(ptySpawnSchema, asObject(a));
  if (!r.ok) return r;
  const v: PtySpawnArgs = { cwd: r.value.cwd };
  if (r.value.shell !== undefined) v.shell = r.value.shell;
  if (r.value.cols !== undefined) v.cols = r.value.cols;
  if (r.value.rows !== undefined) v.rows = r.value.rows;
  if (r.value.venv !== undefined && r.value.venv !== null) v.venv = r.value.venv;
  return { ok: true, value: v };
}

export function validatePtyWrite(a: unknown): GuardResult<{ ptyId: string; data: string }> {
  return runSchema(ptyWriteSchema, asObject(a));
}
export function validatePtyResize(
  a: unknown,
): GuardResult<{ ptyId: string; cols: number; rows: number }> {
  return runSchema(ptyResizeSchema, asObject(a));
}
export function validatePtyKill(a: unknown): GuardResult<{ ptyId: string }> {
  return runSchema(ptyKillSchema, asObject(a));
}
export function validateFloatingTerminalCreate(
  a: unknown,
): GuardResult<{ ptyId: string; title: string; scheme?: string }> {
  const r = runSchema(floatingTerminalCreateSchema, asObject(a));
  if (!r.ok) return r;
  const v: { ptyId: string; title: string; scheme?: string } = {
    ptyId: r.value.ptyId,
    title: r.value.title,
  };
  if (r.value.scheme !== undefined) v.scheme = r.value.scheme;
  return { ok: true, value: v };
}
export function validateFloatingTerminalClose(a: unknown): GuardResult<{ ptyId: string }> {
  return runSchema(floatingTerminalCloseSchema, asObject(a));
}

export function validateGitRoot(a: unknown): GuardResult<{ root: string }> {
  return runSchema(gitRootSchema, asObject(a));
}
export function validateGitDiff(
  a: unknown,
): GuardResult<{ root: string; file: string; staged: boolean }> {
  return runSchema(gitDiffSchema, asObject(a));
}
export function validateGitFiles(a: unknown): GuardResult<{ root: string; files: string[] }> {
  return runSchema(gitFilesSchema, asObject(a));
}
export function validateGitCommit(
  a: unknown,
): GuardResult<{ root: string; message: string; amend: boolean }> {
  return runSchema(gitCommitSchema, asObject(a));
}
export function validateGitBranch(
  a: unknown,
): GuardResult<{ root: string; name: string; create: boolean }> {
  return runSchema(gitBranchSchema, asObject(a));
}

export interface GitWorktreeCreateArgs {
  root: string;
  branch: string;
  path?: string;
}
export function validateGitWorktreeCreate(a: unknown): GuardResult<GitWorktreeCreateArgs> {
  const r = runSchema(gitWorktreeCreateSchema, asObject(a));
  if (!r.ok) return r;
  const v: GitWorktreeCreateArgs = { root: r.value.root, branch: r.value.branch };
  if (r.value.path !== undefined) v.path = r.value.path;
  return { ok: true, value: v };
}
export function validateGitWorktreeRemove(a: unknown): GuardResult<{ root: string; path: string }> {
  return runSchema(gitWorktreeRemoveSchema, asObject(a));
}

export interface GitStashArgs {
  root: string;
  message?: string;
}
export function validateGitStash(a: unknown): GuardResult<GitStashArgs> {
  const r = runSchema(gitStashSchema, asObject(a));
  if (!r.ok) return r;
  const v: GitStashArgs = { root: r.value.root };
  if (r.value.message !== undefined) v.message = r.value.message;
  return { ok: true, value: v };
}
export interface GitStashRefArgs {
  root: string;
  index?: number;
}
export function validateGitStashRef(a: unknown): GuardResult<GitStashRefArgs> {
  const r = runSchema(gitStashRefSchema, asObject(a));
  if (!r.ok) return r;
  const v: GitStashRefArgs = { root: r.value.root };
  if (r.value.index !== undefined) v.index = r.value.index;
  return { ok: true, value: v };
}
export function validateGitBlame(a: unknown): GuardResult<{ root: string; file: string }> {
  return runSchema(gitBlameSchema, asObject(a));
}
export function validateGitCheckoutSide(
  a: unknown,
): GuardResult<{ root: string; file: string; side: "ours" | "theirs" }> {
  return runSchema(gitCheckoutSideSchema, asObject(a));
}
export function validateGitCommitRef(a: unknown): GuardResult<{ root: string; hash: string }> {
  return runSchema(gitCommitRefSchema, asObject(a));
}
export function validateGitConflictVersions(
  a: unknown,
): GuardResult<{ root: string; file: string }> {
  return runSchema(gitConflictVersionsSchema, asObject(a));
}
export function validateGitRebaseTodo(a: unknown): GuardResult<{ root: string; base: string }> {
  return runSchema(gitRebaseTodoSchema, asObject(a));
}
export interface GitRebaseRunArgs {
  root: string;
  base: string;
  todo: {
    sha: string;
    action: "pick" | "reword" | "squash" | "fixup" | "drop";
    subject: string;
    message?: string;
  }[];
}
export function validateGitRebaseRun(a: unknown): GuardResult<GitRebaseRunArgs> {
  return runSchema(gitRebaseRunSchema, asObject(a)) as GuardResult<GitRebaseRunArgs>;
}
export interface GitApplyPatchArgs {
  root: string;
  patch: string;
  cached: boolean;
  reverse: boolean;
}
export function validateGitApplyPatch(a: unknown): GuardResult<GitApplyPatchArgs> {
  return runSchema(gitApplyPatchSchema, asObject(a)) as GuardResult<GitApplyPatchArgs>;
}
export function validateGitPrGet(a: unknown): GuardResult<{ root: string; number: number }> {
  return runSchema(gitPrGetSchema, asObject(a));
}
export function validateGitPrComment(
  a: unknown,
): GuardResult<{ root: string; number: number; body: string }> {
  return runSchema(gitPrCommentSchema, asObject(a));
}
export function validateGitPrSetToken(a: unknown): GuardResult<{ root: string; token: string }> {
  return runSchema(gitPrSetTokenSchema, asObject(a));
}
export function validateSqlConnect(a: unknown): GuardResult<{ conn: string }> {
  return runSchema(sqlConnectSchema, asObject(a));
}
export interface SqlQueryArgs {
  conn: string;
  sql: string;
  params?: unknown[];
  page?: number;
  pageSize?: number;
  timeoutS?: number;
}
export function validateSqlQuery(a: unknown): GuardResult<SqlQueryArgs> {
  return runSchema(sqlQuerySchema, asObject(a)) as GuardResult<SqlQueryArgs>;
}
export function validateSqlSchema(a: unknown): GuardResult<{ conn: string; table?: string }> {
  return runSchema(sqlSchemaSchema, asObject(a));
}
export function validateKernelStart(
  a: unknown,
): GuardResult<{ cwd: string; env?: Record<string, string> }> {
  const r = runSchema(kernelStartSchema, asObject(a));
  if (!r.ok) return r;
  const v: { cwd: string; env?: Record<string, string> } = { cwd: r.value.cwd };
  if (r.value.env !== undefined) v.env = r.value.env;
  return { ok: true, value: v };
}
export function validateKernelExecute(
  a: unknown,
): GuardResult<{ sessionId: string; cellId: string; code: string }> {
  return runSchema(kernelExecuteSchema, asObject(a));
}
export function validateKernelSession(a: unknown): GuardResult<{ sessionId: string }> {
  return runSchema(kernelSessionSchema, asObject(a));
}
export function validateKernelDataframe(a: unknown): GuardResult<{
  sessionId: string;
  name: string;
  offset: number;
  limit: number;
}> {
  const r = runSchema(kernelDataframeSchema, asObject(a));
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      sessionId: r.value.sessionId,
      name: r.value.name,
      offset: r.value.offset ?? 0,
      limit: r.value.limit ?? 100,
    },
  };
}
export interface TerminalEnvArg {
  name: string;
  path: string;
  kind: string;
  pythonVersion?: string | null;
}
export function validateTerminalMenu(
  a: unknown,
): GuardResult<{ workspaceRoot: string; envs?: TerminalEnvArg[] }> {
  const r = runSchema(terminalMenuSchema, asObject(a));
  if (!r.ok) return r;
  const v: { workspaceRoot: string; envs?: TerminalEnvArg[] } = {
    workspaceRoot: r.value.workspaceRoot,
  };
  if (r.value.envs !== undefined) v.envs = r.value.envs as TerminalEnvArg[];
  return { ok: true, value: v };
}
export function validateTerminalResolve(a: unknown): GuardResult<{
  id: string;
  workspaceRoot: string;
  envs?: TerminalEnvArg[];
  activeEnvPath?: string | null;
  fileDir?: string;
}> {
  const r = runSchema(terminalResolveSchema, asObject(a));
  if (!r.ok) return r;
  const v: {
    id: string;
    workspaceRoot: string;
    envs?: TerminalEnvArg[];
    activeEnvPath?: string | null;
    fileDir?: string;
  } = { id: r.value.id, workspaceRoot: r.value.workspaceRoot };
  if (r.value.envs !== undefined) v.envs = r.value.envs as TerminalEnvArg[];
  if (r.value.activeEnvPath !== undefined && r.value.activeEnvPath !== null) {
    v.activeEnvPath = r.value.activeEnvPath;
  }
  if (r.value.fileDir !== undefined) v.fileDir = r.value.fileDir;
  return { ok: true, value: v };
}
export interface RepoMapArgs {
  root: string;
  files?: string[];
  budget?: number;
  query?: string;
}
export function validateRepoMap(a: unknown): GuardResult<RepoMapArgs> {
  const r = runSchema(repoMapSchema, asObject(a));
  if (!r.ok) return r;
  const v: RepoMapArgs = { root: r.value.root };
  if (r.value.files !== undefined) v.files = r.value.files;
  if (r.value.budget !== undefined) v.budget = r.value.budget;
  if (r.value.query !== undefined) v.query = r.value.query;
  return { ok: true, value: v };
}
export interface ProfileStartArgs {
  path: string;
  workspaceRoot: string;
  cwd?: string;
  args?: string[];
  timeoutS?: number;
  head?: string;
  mode?: "cpu" | "memory" | "async";
}
export function validateProfileStart(a: unknown): GuardResult<ProfileStartArgs> {
  const r = runSchema(profileStartSchema, asObject(a));
  if (!r.ok) return r;
  const v: ProfileStartArgs = { path: r.value.path, workspaceRoot: r.value.workspaceRoot };
  if (r.value.cwd !== undefined) v.cwd = r.value.cwd;
  if (r.value.args !== undefined) v.args = r.value.args;
  if (r.value.timeoutS !== undefined) v.timeoutS = r.value.timeoutS;
  if (r.value.head !== undefined) v.head = r.value.head;
  if (r.value.mode !== undefined) v.mode = r.value.mode;
  return { ok: true, value: v };
}
export interface ProfileSnapshotSaveArgs {
  name: string;
  mode: "cpu" | "memory" | "async";
  unit: string;
  samples: { stack: string[]; value: number }[];
  totalValue: number;
}
export function validateProfileSnapshotSave(a: unknown): GuardResult<ProfileSnapshotSaveArgs> {
  return runSchema(profileSnapshotSaveSchema, asObject(a));
}
export function validateProfileCompare(a: unknown): GuardResult<{ aId: string; bId: string }> {
  return runSchema(profileCompareSchema, asObject(a));
}
export function validateGitReset(
  a: unknown,
): GuardResult<{ root: string; hash: string; mode: "soft" | "mixed" | "hard" }> {
  return runSchema(gitResetSchema, asObject(a));
}
export function validateGitLog(a: unknown): GuardResult<{ root: string; limit: number }> {
  return runSchema(gitLogSchema, asObject(a));
}

export interface GateArgs {
  workspaceRoot: string;
  head?: string;
  runId?: string;
}
export function validateGate(a: unknown): GuardResult<GateArgs> {
  const r = runSchema(gateSchema, asObject(a));
  if (!r.ok) return r;
  const v: GateArgs = { workspaceRoot: r.value.workspaceRoot };
  if (r.value.head !== undefined) v.head = r.value.head;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export function validateExec(a: unknown): GuardResult<{ command: string; cwd: string }> {
  return runSchema(execSchema, asObject(a));
}

export interface SearchArgs {
  root: string;
  query: string;
  mode?: "content" | "path";
  extensions?: string[];
  caseSensitive?: boolean;
  maxResults?: number;
  include?: string[];
  exclude?: string[];
  requestId?: string;
}
export function validateSearch(a: unknown): GuardResult<SearchArgs> {
  const r = runSchema(searchSchema, asObject(a));
  if (!r.ok) return r;
  // segment-wise traversal/absolute rejection for the scope globs (APP-024) —
  // done here (not a zod refine) so the node:test zod double stays sufficient.
  for (const field of ["include", "exclude"] as const) {
    for (const g of r.value[field] ?? []) {
      const err = globPatternError(g);
      if (err)
        return {
          ok: false,
          error: { kind: "invalid-args", message: err, detail: `at "${field}"` },
        };
    }
  }
  const v: SearchArgs = { root: r.value.root, query: r.value.query };
  if (r.value.mode !== undefined) v.mode = r.value.mode;
  if (r.value.extensions !== undefined) v.extensions = r.value.extensions;
  if (r.value.caseSensitive !== undefined) v.caseSensitive = r.value.caseSensitive;
  if (r.value.maxResults !== undefined) v.maxResults = r.value.maxResults;
  if (r.value.include !== undefined) v.include = r.value.include;
  if (r.value.exclude !== undefined) v.exclude = r.value.exclude;
  if (r.value.requestId !== undefined) v.requestId = r.value.requestId;
  return { ok: true, value: v };
}

/** APP-066: cancel a search by its opaque requestId (no path, so no path guard). */
export interface SearchCancelArgs {
  requestId: string;
}
export function validateSearchCancel(a: unknown): GuardResult<SearchCancelArgs> {
  const r = runSchema(searchCancelSchema, asObject(a));
  if (!r.ok) return r;
  return { ok: true, value: { requestId: r.value.requestId } };
}

export interface TestRunArgs {
  root: string;
  framework: "pytest" | "unittest";
  ids: string[];
  rerun?: boolean;
}
export function validateTestRun(a: unknown): GuardResult<TestRunArgs> {
  const r = runSchema(testRunSchema, asObject(a));
  if (!r.ok) return r;
  const v: TestRunArgs = { root: r.value.root, framework: r.value.framework, ids: r.value.ids };
  if (r.value.rerun !== undefined) v.rerun = r.value.rerun;
  return { ok: true, value: v };
}
export function validateCoverageRun(
  a: unknown,
): GuardResult<{ root: string; framework: "pytest" | "unittest"; ids: string[] }> {
  return runSchema(coverageRunSchema, asObject(a));
}
export function validateCoverageImport(a: unknown): GuardResult<{ path: string }> {
  return runSchema(coverageImportSchema, asObject(a));
}
