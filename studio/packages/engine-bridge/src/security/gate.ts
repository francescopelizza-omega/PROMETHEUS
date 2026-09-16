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
  /**
   * Text piped to nemesis's stdin, then closed — for `nemesis gate -`, which scans whatever
   * arrives there.
   *
   * This is the seam `prometheus.py` already uses via `enforce_gate_text` to vet a shell body
   * BEFORE running it. Without it the bridge could only gate a PATH, so a proposed command
   * line had no way to reach the scanner at all. Nothing touches disk: the text goes straight
   * down the pipe.
   */
  stdin?: string;
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

    // setEncoding, not per-chunk `b.toString()`: a multi-byte character split across a chunk
    // boundary decodes to U+FFFD on both sides. This is the gate's OWN output — a corrupted
    // path or finding in a verdict is a security report the user cannot act on.
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_NEMESIS_STDOUT_BYTES) {
        finishReject(
          new EngineError(
            `nemesis emitted more than ${Math.round(MAX_NEMESIS_STDOUT_BYTES / 1e6)}MB — aborted (fail-closed)`,
            { code: "engine_error", stderrTail: stderr.slice(-2000) },
          ),
        );
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
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

    // Pipe the body BEFORE closing (nemesis `gate -` reads stdin). `end()` on its own is the
    // no-stdin case and stays the default.
    if (typeof opts.stdin === "string" && opts.stdin.length > 0) {
      try {
        child.stdin?.write(opts.stdin);
      } catch {
        /* a closed pipe surfaces as a spawn/exit error below — fail closed there */
      }
    }
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
  /**
   * A dash-leading target is not a target — it is a flag, and nemesis reads `-` as "the body is
   * on stdin".
   *
   * `runNemesis` writes no stdin for a gate and closes the pipe immediately, so `gate("-")`
   * made nemesis scan an EMPTY body and answer with a perfectly well-formed
   * `verdict:"allow", risk_score:0, exit 0` — which reconciled cleanly and returned a clean
   * SecurityVerdict whose `target` had even been replaced by nemesis's own `"<stdin>"`. Nothing
   * was scanned and everything downstream was told it was safe. It is reachable: a `.promext`
   * manifest's `repo` is accepted verbatim (`ext/manifest.ts`), wins over the staging dir
   * (`ext/loader.ts` gateTargetFor), and is handed to this function by the desktop's extension
   * host — so a downloaded extension declaring `"repo": "-"` installed with neither the repo nor
   * its staging directory ever scanned.
   *
   * This package already owns the guard for exactly this input class one directory over:
   * `commands.ts`'s `notFlag()` — "a value starting with '-' is … an attempt to smuggle a flag
   * into the engine's argparse — reject it loudly" — applied to every catalog builder and to
   * none of the security path. Both halves are fixed: refuse the input, and pass `--` so no
   * future target can be reinterpreted as an option either.
   *
   * The file header promises "FAIL-CLOSED (C5) … we can never under-report risk". This is what
   * makes that true for a dash-leading target.
   */
  if (target.trimStart().startsWith("-")) {
    return failClosedVerdict(target, `refusing an option-shaped scan target: ${target}`);
  }

  let res: NemesisRunResult;
  try {
    // `--` ends the option list: a target can never be consumed as a nemesis flag.
    res = await runNemesis(["gate", "--", target], opts, config);
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

/**
 * Gate a proposed COMMAND LINE through nemesis (full_wrapper_compose §6, layer 3).
 *
 * The other four layers reason about structure — can we parse it, do we know the programs,
 * what does the ladder say, does the human agree. This layer is the only one that asks the
 * question the rest of Prometheus asks about everything else it runs: *does the scanner think
 * this is malicious?* Nemesis already carries the rules (`R2.pipe` for pipe-to-shell,
 * `R3.sudo`, and the rest of the table), and `gate -` already reads stdin — the only thing
 * missing was a caller.
 *
 * FAIL-CLOSED, exactly like `gate()`: a missing binary, a timeout, an unparseable verdict —
 * anything that leaves us without a trustworthy answer — comes back as `error`, which the
 * agent loop treats as a BLOCK under `gateMode: "enforce"`.
 *
 * The text scanned is the RE-RENDERED command (what will actually run), never the model's
 * original string, so the scanner and the executor see the same thing.
 */
export async function gateCommand(
  commandText: string,
  opts: RunOptions = {},
  config: EngineConfig = {},
): Promise<SecurityVerdict> {
  const text = (commandText ?? "").trim();
  if (!text) return failClosedVerdict("<command>", "empty command");
  // A short, self-contained body: a command line is one line, so the long install-scan
  // budget would only turn a wedged scanner into a wedged turn.
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return gateStdinText(text, `command: ${text.slice(0, 120)}`, { ...opts, timeoutMs }, config);
}

/**
 * Scan an in-memory body through `nemesis gate -`.
 *
 * Shares `gate()`'s reconciliation rules verbatim: take the MORE conservative of the exit-code
 * tier and the JSON tier, and treat "no parseable verdict JSON" as untrustworthy rather than
 * as permission.
 */
async function gateStdinText(
  body: string,
  label: string,
  opts: RunOptions,
  config: EngineConfig,
): Promise<SecurityVerdict> {
  let res: NemesisRunResult;
  try {
    res = await runNemesis(["gate", "-"], { ...opts, stdin: body }, config);
  } catch (e) {
    return failClosedVerdict(label, e instanceof Error ? e.message : String(e));
  }

  const exitTier = tierFromExitCode(res.exitCode);
  const json =
    res.json && typeof res.json === "object" && !Array.isArray(res.json)
      ? (res.json as Record<string, unknown>)
      : undefined;

  if (!json) {
    // A permissive exit code with no verdict JSON is not evidence of safety — same rule
    // `gate()` applies, for the same reason (a broken or hijacked scanner).
    if (exitTier === "allow" || exitTier === "warn") {
      return failClosedVerdict(label, "nemesis produced no parseable verdict JSON");
    }
    return {
      verdict: exitTier,
      risk_score: 100,
      signed: false,
      findings: [],
      scannedAt: new Date().toISOString(),
      target: label,
    };
  }

  const verdict = moreConservative(exitTier, normalizeVerdict(json.verdict));
  const risk =
    typeof json.risk_score === "number"
      ? json.risk_score
      : verdict === "allow"
        ? 0
        : verdict === "warn"
          ? 50
          : 100;
  const reasons = Array.isArray(json.blocking_reasons)
    ? json.blocking_reasons.filter((r): r is string => typeof r === "string")
    : [];
  return {
    verdict,
    risk_score: risk,
    signed: json.signed === true,
    // `blocking_reasons` are PROSE, and they stay prose. They used to be mapped into the
    // Finding shape "so every surface that already renders a verdict renders this one too" —
    // which required inventing a rule id (`"nemesis"`) and deriving a severity from the
    // decision tier, the conflation handoff §4 names outright. A surface that wants to show
    // them reads `blockingReasons` and renders them as reasons.
    findings: [],
    ...(reasons.length > 0 ? { blockingReasons: reasons } : {}),
    scannedAt: new Date().toISOString(),
    target: label,
  };
}
