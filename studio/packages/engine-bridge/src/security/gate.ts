/**
 * security/gate.ts — the nemesis gate runner (C4, C5).
 *
 * gate(target) executes `nemesis gate <target>`, which prints the full verdict
 * JSON (schema "nemesis.verdict/1") on stdout and exits with a DECISION code:
 *   0 allow · 10 warn · 20 block · 2 error.
 *
 * We render that verdict — JS NEVER decides "safe". FAIL-CLOSED (C5): a missing
 * nemesis binary, a spawn failure, a timeout, or unparseable output all collapse
 * to verdict "error" (treated as BLOCK). We trust the exit code as the primary
 * decision and reconcile it with the JSON `verdict` field, taking the MORE
 * conservative of the two so we can never under-report risk.
 *
 * Probed against the real binary (nemesis 1.12.0): `gate` already prints the
 * structured verdict to stdout in machine mode, so no extra flag is needed.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { DEFAULT_TIMEOUT_MS, type EngineConfig, resolveEngine } from "../config.js";
import { EngineError } from "../errors.js";
import { safeChildEnv } from "../safe-env.js";
import {
  type Finding,
  type SecurityVerdict,
  type VerdictTier,
  normalizeKlass,
  normalizeSeverity,
  normalizeVerdict,
  tierFromExitCode,
} from "./verdict.js";

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStderr?: (line: string) => void;
}

export interface NemesisRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: unknown;
}

/** Rank tiers so we can always take the MORE conservative of exit vs. json. */
const TIER_RANK: Record<VerdictTier, number> = { allow: 0, warn: 1, block: 2, error: 3 };

/** Hard ceiling on nemesis stdout — abort fail-closed before a runaway OOMs the host. */
const MAX_NEMESIS_STDOUT_BYTES = 64 * 1024 * 1024;

function moreConservative(a: VerdictTier, b: VerdictTier): VerdictTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Whole-string parse first (nemesis gate prints exactly one object).
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall back to a per-line LAST-to-first object scan */
  }
  // A global indexOf("{")…lastIndexOf("}") slice can span a benign log line's brace
  // through to a later one and parse garbage (or the wrong object). Instead scan each
  // line from LAST to first and take the last line that is itself a JSON object — the
  // verdict is emitted last, after any human log lines (mirrors parseEngineObject).
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || line[0] !== "{") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* not this line — keep scanning upward */
    }
  }
  return undefined;
}

/**
 * Spawn `nemesis <argv...>` and capture stdout/stderr/exit. shell:false. No
 * fail-closed mapping here — that is gate()'s job; this is the raw runner that
 * EngineClient.runNemesis exposes. A missing binary / spawn error still REJECTS
 * with a typed EngineError so callers cannot mistake it for a clean run.
 */
export function runNemesis(
  argv: string[],
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<NemesisRunResult> {
  const { nemesisBin } = resolveEngine(config);
  const timeoutMs = opts.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!existsSync(nemesisBin)) {
    return Promise.reject(
      new EngineError(`nemesis binary not found at ${nemesisBin}`, {
        code: "nemesis_unavailable",
        stderrTail: "Set NEMESIS_BIN to its absolute path.",
      }),
    );
  }

  return new Promise<NemesisRunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new EngineError("aborted before spawn", { code: "nemesis_unavailable" }));
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(nemesisBin, argv, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: opts.cwd ?? config.cwd,
        env: safeChildEnv(),
      });
    } catch (err) {
      reject(
        new EngineError(`failed to launch nemesis: ${(err as Error).message}`, {
          code: "nemesis_unavailable",
          cause: err,
        }),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let stderrLineBuf = "";
    let settled = false;

    const onAbort = () =>
      finishReject(new EngineError("nemesis run aborted", { code: "nemesis_unavailable" }));

    const cleanup = () => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    const finishReject = (e: EngineError) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      reject(e);
    };

    const timer = setTimeout(() => {
      finishReject(
        new EngineError(`nemesis timed out after ${Math.round(timeoutMs / 1000)}s`, {
          code: "timeout",
          stderrTail: stderr.slice(-2000),
        }),
      );
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString();
      if (stdout.length > MAX_NEMESIS_STDOUT_BYTES) {
        finishReject(
          new EngineError(
            `nemesis emitted more than ${Math.round(MAX_NEMESIS_STDOUT_BYTES / 1e6)}MB — aborted (fail-closed)`,
            { code: "engine_error", stderrTail: stderr.slice(-2000) },
          ),
        );
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      const chunk = b.toString();
      stderr += chunk;
      if (opts.onStderr) {
        let rest = stderrLineBuf + chunk;
        let nl = rest.indexOf("\n");
        while (nl !== -1) {
          const line = rest.slice(0, nl).replace(/\r$/, "");
          if (line.length) opts.onStderr(line);
          rest = rest.slice(nl + 1);
          nl = rest.indexOf("\n");
        }
        stderrLineBuf = rest;
      }
    });

    child.stdin?.end();

    child.on("error", (err: Error) => {
      finishReject(
        new EngineError(`failed to launch nemesis: ${err.message}`, {
          code: "nemesis_unavailable",
          cause: err,
        }),
      );
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (opts.onStderr && stderrLineBuf.trim()) opts.onStderr(stderrLineBuf.trim());
      resolve({
        exitCode: code ?? 2, // null (signalled) => error tier
        stdout,
        stderr,
        json: tryParseJson(stdout),
      });
    });
  });
}

/** Extract Finding[] from a nemesis verdict's top_findings array. */
function findingsFromVerdict(json: Record<string, unknown>): Finding[] {
  const raw = json.top_findings;
  if (!Array.isArray(raw)) return [];
  const out: Finding[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path : "";
    const line = typeof o.line === "number" ? `:${o.line}` : "";
    out.push({
      klass: normalizeKlass(o.class),
      severity: normalizeSeverity(o.severity),
      rule: String(o.rule ?? o.rule_id ?? "unknown"),
      where: `${path}${line}` || String(o.rule_id ?? "unknown"),
    });
  }
  return out;
}

/**
 * Gate an arbitrary path / git URL / owner-repo through nemesis and return a
 * normalised SecurityVerdict. FAIL-CLOSED: any failure to obtain a trustworthy
 * verdict => verdict "error" (a BLOCK). The exit-code tier and the JSON verdict
 * are reconciled by taking the MORE conservative of the two.
 */
export async function gate(
  target: string,
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<SecurityVerdict> {
  if (!target || !target.trim()) {
    // No target => nothing trustworthy to render => fail closed.
    return failClosedVerdict(target, "empty target");
  }

  let res: NemesisRunResult;
  try {
    res = await runNemesis(["gate", target], opts, config);
  } catch (e) {
    // missing binary / spawn / timeout / abort => fail closed BLOCK.
    const msg = e instanceof Error ? e.message : String(e);
    return failClosedVerdict(target, msg);
  }

  const exitTier = tierFromExitCode(res.exitCode);
  const json =
    res.json && typeof res.json === "object" && !Array.isArray(res.json)
      ? (res.json as Record<string, unknown>)
      : undefined;

  // `nemesis gate` ALWAYS prints the verdict JSON. No parseable object means a
  // broken/hijacked/truncated scanner — a permissive exit code (allow/warn) cannot
  // be trusted on its own, so we fail CLOSED (mirrors gateFull's contract check). A
  // block/error exit stays at least as conservative as the fail-closed "error".
  if (!json) {
    if (exitTier === "allow" || exitTier === "warn") {
      return failClosedVerdict(target, "nemesis produced no parseable verdict JSON");
    }
    return {
      verdict: exitTier, // block / error — already dangerous, keep it
      risk_score: 100,
      signed: false,
      findings: [],
      scannedAt: new Date().toISOString(),
      target,
    };
  }

  const jsonTier = normalizeVerdict(json.verdict);
  const verdict = moreConservative(exitTier, jsonTier);

  const risk =
    typeof json.risk_score === "number"
      ? json.risk_score
      : verdict === "allow"
        ? 0
        : verdict === "warn"
          ? 50
          : 100;

  const scannedAt =
    typeof json.scanned_at === "string" ? json.scanned_at : new Date().toISOString();
  const tgt = typeof json.target === "string" ? json.target : target;
  // nemesis signs only when asked (--sign); detect a signature field if present.
  const signed = json.signed === true || typeof json.signature === "string";

  return {
    verdict,
    risk_score: risk,
    signed,
    findings: findingsFromVerdict(json),
    scannedAt,
    target: tgt,
  };
}

/** Build the fail-closed BLOCK verdict (verdict "error", risk 100). */
function failClosedVerdict(target: string, reason: string): SecurityVerdict {
  return {
    verdict: "error",
    risk_score: 100,
    signed: false,
    findings: [
      {
        klass: "malware",
        severity: "critical",
        rule: "nemesis-unavailable",
        where: reason,
      },
    ],
    scannedAt: new Date().toISOString(),
    target,
  };
}
