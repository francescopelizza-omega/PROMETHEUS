// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/test-run-host.ts — stream a testmgr.py `run` / `rerun-failed` verb (APP-013).
 *
 * `runSidecar` (sidecar.ts → engine-bridge) is request/response: it resolves ONCE with
 * the last JSON object, so live per-test events would all arrive at exit. This host
 * instead drives the sidecar through an INJECTED spawn fn (main/index.ts supplies the
 * real node:child_process spawn with the safe child env; node:test injects a fake —
 * mirroring the LSP/DAP/PTY host discipline), line-buffers stdout (a JSON line can be
 * split across chunk boundaries), forwards each `{event:"test"}` line to `onEvent`,
 * and resolves with the terminal `{ok, command, summary}` envelope.
 *
 * Fail-closed hardening (mirrors the engine-bridge sidecar runner): stdout cap →
 * SIGKILL, timeout → SIGKILL, and a caller-owned kill registry so ide-ipc's disposer
 * reaps live children on window close (no orphaned pytest processes).
 */
import { join } from "node:path";

import { resolveSidecarDir } from "@prometheus/engine-bridge";

import type {
  IdeTestEvent,
  IdeTestRunResult,
  IdeTestRunSummary,
} from "../../shared/ipc-contract.js";

/** The minimal child surface this host needs (a real ChildProcess satisfies it). */
export interface TestRunChild {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

/** The injected spawn seam (shell:false + safe env are the CALLER's obligation). */
export type TestRunSpawn = (cmd: string, args: string[], opts: { cwd: string }) => TestRunChild;

export interface TestRunRequest {
  root: string;
  framework: "pytest" | "unittest";
  ids: string[];
  /** true → the sidecar's `rerun-failed` verb (`--failed` ids); else `run` (`--id`). */
  rerun?: boolean;
}

export interface TestRunOptions {
  pythonBin?: string;
  sidecarDir?: string;
  timeoutMs?: number;
  /** live children register a killer here; the ide-ipc disposer reaps them. */
  kills?: Set<() => void>;
}

/** A whole test run is bounded (a hung pytest must not leak forever). */
const TEST_RUN_TIMEOUT_MS = 600_000;
/** Cap on buffered child output — abort fail-closed before a runaway OOMs main. */
const MAX_RUN_STDOUT_BYTES = 8 * 1024 * 1024;
/** Bounded stderr tail kept for the no-envelope diagnostic. */
const STDERR_TAIL_CHARS = 600;

const TEST_STATUSES = new Set(["pass", "fail", "skip"]);

function pythonBin(opts: TestRunOptions): string {
  return opts.pythonBin || process.env.PYTHON || process.env.PYTHON_BIN || "python3";
}

/**
 * Build the sidecar argv (exported for tests): `testmgr.py <verb> --path <root>
 * --framework <fw> --id|--failed <id> …`. Every id rides behind its own flag —
 * the leading-dash/metachar guard already ran at the zod seam AND re-runs in the
 * sidecar before ITS pytest/unittest argv (where the `--` separator lives).
 */
export function buildTestArgv(req: TestRunRequest, sidecarDir?: string): string[] {
  const script = join(resolveSidecarDir(sidecarDir), "testmgr.py");
  const verb = req.rerun ? "rerun-failed" : "run";
  const flag = req.rerun ? "--failed" : "--id";
  const args = [script, verb, "--path", req.root, "--framework", req.framework];
  for (const id of req.ids) args.push(flag, id);
  return args;
}

/** Shape a parsed `{event:"test"}` JSON line down to a renderer-safe IdeTestEvent. */
function toTestEvent(o: Record<string, unknown>): IdeTestEvent | null {
  if (typeof o.id !== "string" || typeof o.status !== "string") return null;
  if (!TEST_STATUSES.has(o.status)) return null;
  const ev: IdeTestEvent = { id: o.id, status: o.status as IdeTestEvent["status"] };
  if (typeof o.message === "string") ev.message = o.message;
  if (typeof o.durationMs === "number") ev.durationMs = o.durationMs;
  // APP-040: per-failure captured output + the failing file:line (follow-up update).
  if (Array.isArray(o.output))
    ev.output = o.output.filter((l): l is string => typeof l === "string");
  if (typeof o.file === "string") ev.file = o.file;
  if (typeof o.line === "number" && Number.isFinite(o.line)) ev.line = o.line;
  return ev;
}

const TAP_RE = /^(ok|not ok)\s+\d+\s*(?:-\s*)?(.*)$/;

/**
 * Parse a vitest/TAP reporter line (`ok N - name` / `not ok N - name [# SKIP]`) into
 * an IdeTestEvent (APP-040). TAP is line-oriented and stream-parseable (unlike the
 * default ANSI-redraw reporter). Non-result lines (the `TAP version`/plan/comments)
 * → null. NOTE: live vitest EXECUTION additionally needs a vitest test-discoverer to
 * produce runnable nodes (deferred — discovery is the AST-python `testmgr`); this pure
 * parser + the `vitest` framework tag are the streaming half, unit-tested with fixtures.
 */
export function parseTapLine(line: string): IdeTestEvent | null {
  const m = TAP_RE.exec(line.trim());
  if (!m) return null;
  let name = (m[2] ?? "").trim();
  let status: IdeTestEvent["status"] = m[1] === "ok" ? "pass" : "fail";
  const directive = /#\s*(skip|todo)\b/i.exec(name);
  if (directive) {
    status = "skip";
    name = name.slice(0, directive.index).trim();
  }
  if (!name) return null;
  return { id: name, status };
}

/**
 * Spawn the run verb and stream it. Resolves (never rejects) with the terminal
 * summary; a missing envelope, spawn failure, cap breach, or timeout is an
 * `{ok:false, error}` result — fail-closed, mirroring runSidecar's contract.
 */
export function runTestVerb(
  spawnFn: TestRunSpawn,
  req: TestRunRequest,
  onEvent: (event: IdeTestEvent) => void,
  opts: TestRunOptions = {},
): Promise<IdeTestRunResult> {
  const args = buildTestArgv(req, opts.sidecarDir);
  const timeoutMs = opts.timeoutMs ?? TEST_RUN_TIMEOUT_MS;

  return new Promise<IdeTestRunResult>((resolve) => {
    let child: TestRunChild;
    try {
      child = spawnFn(pythonBin(opts), args, { cwd: req.root });
    } catch (err) {
      resolve({ ok: false, error: `failed to launch test run: ${(err as Error).message}` });
      return;
    }

    let settled = false;
    let buffer = "";
    let bytes = 0;
    let stderrTail = "";
    let envelope: Record<string, unknown> | null = null;

    const killer = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    };
    opts.kills?.add(killer);

    const done = (result: IdeTestRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.kills?.delete(killer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killer();
      done({ ok: false, error: `test run timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const onLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return; // stray non-JSON output — ignore
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // a torn/garbled line never crashes the run
      }
      if (!parsed || typeof parsed !== "object") return;
      const o = parsed as Record<string, unknown>;
      if (o.event === "test") {
        const ev = toTestEvent(o);
        if (ev) onEvent(ev);
        return;
      }
      if ("ok" in o || "command" in o) envelope = o; // the terminal envelope (LAST line)
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      bytes += text.length;
      if (bytes > MAX_RUN_STDOUT_BYTES) {
        killer();
        done({
          ok: false,
          error: `test run emitted more than ${Math.round(MAX_RUN_STDOUT_BYTES / 1e6)}MB — aborted (fail-closed)`,
        });
        return;
      }
      buffer += text;
      // split complete JSON lines; keep the trailing partial for the next chunk.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
    });

    child.on("error", (err: Error) => {
      done({ ok: false, error: `failed to launch test run: ${err.message}` });
    });

    child.on("close", (code: number | null) => {
      if (buffer.trim()) onLine(buffer); // flush a final unterminated line
      if (!envelope) {
        const tail = stderrTail.trim().slice(-300);
        done({
          ok: false,
          error: `testmgr produced no terminal envelope (exit ${code ?? "?"})${tail ? `: ${tail}` : ""}`,
        });
        return;
      }
      const result: IdeTestRunResult = { ok: envelope.ok !== false };
      if (envelope.summary && typeof envelope.summary === "object") {
        result.summary = envelope.summary as IdeTestRunSummary;
      }
      if (typeof envelope.error === "string") result.error = envelope.error;
      done(result);
    });
  });
}
