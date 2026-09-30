/**
 * main/budget-gate.ts — the desktop's spend cap, enforced in MAIN (Task #1 item 2).
 *
 * THE GAP THIS CLOSES. The desktop had no spend enforcement of any kind. It also had no
 * accounting: `run-controller.ts` accumulates a per-tab `UsageTotals` in an in-memory `Map`
 * that dies on window reload, and it computes cost with a hard-coded `null` price, so
 * `costUsd` was permanently `null` and the `SpendMeter` branch that would have displayed it
 * could never even be reached. Meanwhile `AgentPane` persisted a `capUsd` to localStorage and
 * captioned it "auto-disable at cap". Nothing read it. The cap was a label over an uncapped
 * turn.
 *
 * WHY MAIN, NOT THE RENDERER. Two reasons, both load-bearing:
 *
 *   1. `runAiStream` is the ONE chokepoint every model call funnels through — the agent loop,
 *      the compaction summarizer, InlineEdit, EditorPane, GitPanel, RefactorPreview and the
 *      database panel all reach the network through it. A renderer-side gate would have to be
 *      added to six call sites and would be missing from the seventh.
 *   2. The renderer is the untrusted side (`sandbox:true`, `contextIsolation:true`). It is
 *      where `cloudAllowed` and `egressAllowed` are already re-checked rather than trusted,
 *      and a cap the spending side can skip is not a cap.
 *
 * The DECISION is not implemented here: it is `ai.decideBudget`, the same function the CLI's
 * `checkBudgetGate` calls. This module is only the host-shaped half — reading and appending
 * records, and resolving the config. That split is the whole point; the previous state of the
 * art was three cost evaluators of which one ran.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ai, type settings as coreSettings } from "@prometheus/core";

/** One metered call, as persisted. Mirrors the CLI's CLI-029 accounting row. */
export interface DesktopSpendRecord {
  atIso: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** true ⇒ token counts were inferred, not reported. Counts as a conservative spend FLOOR. */
  estimated: boolean;
}

/** Where the day's files live under Electron's userData dir. */
export function accountingDir(userDataPath: string): string {
  return join(userDataPath, "accounting");
}

/** One file per local calendar day, so the daily window is a cheap directory read. */
export function dayFileName(atIso: string): string {
  const d = new Date(atIso);
  if (Number.isNaN(d.getTime())) return "invalid.jsonl";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
}

/**
 * Parse a JSONL accounting file into records.
 *
 * THROWS when the file exists but cannot be read — that is the fail-closed case and the
 * caller depends on it. A malformed LINE is skipped rather than fatal: one truncated append
 * (a crash mid-write) should not permanently block every future turn, whereas an unreadable
 * or chmod-000 store is exactly the "cap silently stops enforcing" hole the CLI already fixed
 * once by making its reader throw instead of returning `[]`.
 */
export function parseAccountingFile(text: string): DesktopSpendRecord[] {
  const out: DesktopSpendRecord[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s) as Partial<DesktopSpendRecord>;
      if (
        typeof r.atIso === "string" &&
        typeof r.model === "string" &&
        typeof r.promptTokens === "number" &&
        typeof r.completionTokens === "number"
      ) {
        out.push({
          atIso: r.atIso,
          model: r.model,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          estimated: r.estimated === true,
        });
      }
    } catch {
      /* a torn line from a crashed append — skip the line, never the whole store */
    }
  }
  return out;
}

/**
 * Append one metered call. FAIL-SOFT: a store we cannot write is a lost record, not a lost
 * turn — the turn already happened and the model was already paid for, so throwing here would
 * only destroy the user's answer after the money was spent. (The READ side is fail-CLOSED, so
 * a store that cannot be read still blocks the NEXT turn.)
 */
export function appendSpendRecord(
  userDataPath: string,
  rec: DesktopSpendRecord,
  sharedDir: string = ai.sharedAccountingDir(),
): void {
  // The SHARED daily ledger first: `budget.dailyUsd` is one number and must be counted from
  // one place, or a user running Studio and the terminal on the same day gets the cap twice.
  // `sharedDir` is a parameter, not a hidden default lookup, so a test can point it at a temp
  // directory instead of appending to the developer's real spend log.
  ai.appendSharedSpend(sharedDir, rec);
  try {
    const dir = accountingDir(userDataPath);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, dayFileName(rec.atIso)), `${JSON.stringify(rec)}\n`, "utf8");
  } catch {
    /* best effort — see above */
  }
}

/**
 * Every record written on the local day containing `nowIso`. Throws if unreadable.
 *
 * Reads the SHARED ledger AND this app's private day file: the daily cap counts every metered
 * call the user made today on any surface, and the private file is still read so a user who
 * upgrades mid-day does not have this morning's spend vanish out of the window. Rows appended
 * since the shared ledger landed are in both files and are counted once.
 */
export function readDayRecords(
  userDataPath: string,
  nowIso: string,
  sharedDir: string = ai.sharedAccountingDir(),
): DesktopSpendRecord[] {
  const shared = ai.readSharedDay(sharedDir, nowIso) as DesktopSpendRecord[];
  const key = (r: DesktopSpendRecord): string =>
    `${r.atIso}|${r.model}|${r.promptTokens}|${r.completionTokens}`;
  const seen = new Set(shared.map(key));
  return [
    ...shared,
    ...readPrivateDayRecords(userDataPath, nowIso).filter((r) => !seen.has(key(r))),
  ];
}

/**
 * This app's OWN rows for the local day. Throws if the file exists but cannot be read.
 *
 * Kept separate from `readDayRecords` because the SESSION window must not see another
 * surface's rows: "this launch" is per-surface by definition, and folding the shared ledger
 * into it would charge a terminal session's spend against Studio's session cap.
 */
function readPrivateDayRecords(userDataPath: string, nowIso: string): DesktopSpendRecord[] {
  const file = join(accountingDir(userDataPath), dayFileName(nowIso));
  try {
    statSync(file);
  } catch {
    return []; // never written today — the normal first run, NOT an error
  }
  // No try/catch: an existing-but-unreadable file MUST throw so the gate fails closed.
  return parseAccountingFile(readFileSync(file, "utf8"));
}

/**
 * The current app run's records.
 *
 * The "session" window is scoped to THIS launch, matching the CLI, where a fresh session id is
 * minted per launch. Implemented as "records written at or after process start" rather than by
 * tagging rows with a session id, so an older row from a previous launch on the same day
 * counts toward the DAILY window (which is the point of having one) and not the session one.
 */
export function readSessionRecords(
  userDataPath: string,
  nowIso: string,
  sinceMs: number,
): DesktopSpendRecord[] {
  return readPrivateDayRecords(userDataPath, nowIso).filter((r) => {
    const t = Date.parse(r.atIso);
    return Number.isFinite(t) && t >= sinceMs;
  });
}

/** Read the budget windows out of resolved settings. */
export function budgetConfigFromSettings(s: coreSettings.Settings | undefined): ai.BudgetConfig {
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  const session = num(s?.["budget.sessionUsd"]);
  const daily = num(s?.["budget.dailyUsd"]);
  const warnAt = num(s?.["budget.warnAtPercent"]);
  const unpriced = s?.["budget.unpricedPolicy"];
  return {
    ...(session !== undefined ? { sessionUsd: session } : {}),
    ...(daily !== undefined ? { dailyUsd: daily } : {}),
    ...(warnAt !== undefined ? { warnAtPercent: warnAt } : {}),
    ...(unpriced === "block" || unpriced === "warn" ? { unpricedPolicy: unpriced } : {}),
  };
}

/**
 * Local model ids, by provider prefix — a deliberately NARROW test.
 *
 * A false negative costs a fail-closed block with a nameable remedy; a false positive would
 * silently disable the cap. Mirrors the CLI's `isLocalModelId` so both hosts agree about which
 * models are genuinely free.
 */
const LOCAL_PREFIXES = ["local", "ollama", "lmstudio", "llamacpp", "llama.cpp", "vllm", "mlx"];

export function isLocalModelId(model: string): boolean {
  const m = model.toLowerCase();
  return LOCAL_PREFIXES.some((p) => m.startsWith(`${p}:`) || m.startsWith(`${p}/`));
}

/**
 * `undefined` means WE DO NOT KNOW; `{null,null}` means known-free.
 *
 * The distinction decides whether a USD cap can be enforced at all — an unpriced record that
 * contributed $0 is what let a large session slip past a $1 cap while the same tokens on a
 * priced model blocked. Identical to the CLI's `makeBudgetGuard` seam, and it has to be: two
 * hosts that disagree about which models are free enforce two different caps.
 */
export function makePriceFor(
  pricing: ai.Pricing,
  isLocal: (model: string) => boolean,
): ai.PriceFor {
  return (model: string) => {
    const p = ai.priceForModel(pricing, model);
    if (p) return { pricePerMTokIn: p.inputUsdPerMTok, pricePerMTokOut: p.outputUsdPerMTok };
    if (isLocal(model)) return { pricePerMTokIn: null, pricePerMTokOut: null };
    return undefined;
  };
}

/** A read-only spend snapshot (roadmap point 4: budget visibility) — see `DesktopBudgetGate.status`. */
export interface BudgetStatusView {
  capped: boolean;
  config: ai.BudgetConfig;
  sessionSpentUsd: number;
  dailySpentUsd: number;
  /** distinct model ids with no price entry — excluded from both totals above. */
  unpriced: string[];
}

/** The live gate — one per app run; `warned` latches so a warn prints once per window. */
export class DesktopBudgetGate {
  private readonly warned = new Set<string>();
  private readonly startedMs: number;
  private readonly userDataPath: string;
  /** where the SHARED daily ledger lives; injectable so a test never touches the real home. */
  private readonly sharedDir: string;
  private pricing: ai.Pricing = {};
  private settings: coreSettings.Settings | undefined;

  // NOTE: plain fields, not TS parameter properties — the repo's test runner strips types
  // rather than compiling them, and `constructor(private x)` is unsupported in strip-only mode.
  constructor(userDataPath: string, opts: { startedMs?: number; sharedDir?: string } = {}) {
    this.userDataPath = userDataPath;
    this.startedMs = opts.startedMs ?? Date.now();
    this.sharedDir = opts.sharedDir ?? ai.sharedAccountingDir();
  }

  /** Adopt resolved settings (startup + every change), exactly like the security posture. */
  setSettings(s: coreSettings.Settings | undefined): void {
    this.settings = s;
  }

  /** Adopt the price table (read once at startup from the providers config). */
  setPricing(p: ai.Pricing): void {
    this.pricing = p;
  }

  config(): ai.BudgetConfig {
    return budgetConfigFromSettings(this.settings);
  }

  /**
   * Decide whether the next metered call may fire.
   *
   * A LOCAL endpoint, or no configured cap, bypasses ENTIRELY and never touches the store —
   * so a corrupt accounting file can never block a turn that could not have cost anything.
   */
  check(opts: {
    locality: "local" | "cloud";
    nowIso?: string;
    isLocalModel?: (model: string) => boolean;
  }): ai.BudgetGateResult {
    const config = this.config();
    if (opts.locality === "local" || !ai.hasBudgetCap(config)) return { action: "ok" };
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const isLocal = opts.isLocalModel ?? (() => false);
    try {
      const sessionRecords = readSessionRecords(this.userDataPath, nowIso, this.startedMs);
      const dayRecords =
        config.dailyUsd !== undefined
          ? readDayRecords(this.userDataPath, nowIso, this.sharedDir)
          : undefined;
      return ai.decideBudget({
        sessionRecords,
        ...(dayRecords ? { dayRecords } : {}),
        config,
        nowIso,
        priceFor: makePriceFor(this.pricing, isLocal),
        warned: this.warned,
      });
    } catch (e) {
      // FAIL-CLOSED, like nemesis: a store we cannot evaluate blocks rather than reading as
      // "$0 spent". There is no `--force-budget` here, so the remedy is to fix the file — the
      // GUI has no per-run override flag and inventing a silent one would be the bypass.
      return {
        action: "block",
        message: `budget check failed (fail-closed block): ${(e as Error).message}`,
      };
    }
  }

  /**
   * A read-only spend snapshot for the Settings ▸ Budget & Spend page (roadmap point 4).
   *
   * Deliberately NOT fail-closed like `check()`: an enforcement gate that cannot read its store
   * must BLOCK the turn (the whole point of CLI-030's fail-closed guarantee), but a STATUS
   * DISPLAY that cannot read its store should show an honest "$0 / unknown" rather than crash
   * the Settings panel — nothing is actually at stake in rendering a number, only in gating a
   * spend. `isLocalModel` defaults to this module's own `isLocalModelId` (unlike `check()`,
   * which lets the caller override it) since a status read has no caller-specific reason not to
   * use the real one.
   */
  status(
    nowIso: string = new Date().toISOString(),
    isLocalModel: (model: string) => boolean = isLocalModelId,
  ): BudgetStatusView {
    const config = this.config();
    const priceFor = makePriceFor(this.pricing, isLocalModel);
    let sessionRecords: DesktopSpendRecord[] = [];
    let dayRecords: DesktopSpendRecord[] = [];
    try {
      sessionRecords = readSessionRecords(this.userDataPath, nowIso, this.startedMs);
    } catch {
      /* unreadable store ⇒ an honest empty snapshot, never a crashed Settings page */
    }
    try {
      dayRecords = readDayRecords(this.userDataPath, nowIso, this.sharedDir);
    } catch {
      /* same */
    }
    const sessionSummary = ai.summarizeSpend(sessionRecords, nowIso, priceFor);
    const daySummary = ai.summarizeSpend(dayRecords, nowIso, priceFor);
    const unpriced = [...new Set([...sessionSummary.unpriced, ...daySummary.unpriced])].sort();
    return {
      capped: ai.hasBudgetCap(config),
      config,
      sessionSpentUsd: sessionSummary.sessionSpentUsd,
      dailySpentUsd: daySummary.dailySpentUsd,
      unpriced,
    };
  }

  /** Record one metered call. No-op for a local endpoint (it can never move a USD cap). */
  record(opts: {
    locality: "local" | "cloud";
    model: string;
    promptTokens: number;
    completionTokens: number;
    estimated?: boolean;
    nowIso?: string;
  }): void {
    if (opts.locality === "local") return;
    appendSpendRecord(
      this.userDataPath,
      {
        atIso: opts.nowIso ?? new Date().toISOString(),
        model: opts.model,
        promptTokens: opts.promptTokens,
        completionTokens: opts.completionTokens,
        estimated: opts.estimated === true,
      },
      this.sharedDir,
    );
  }
}

/**
 * The process-wide gate. Null until `initBudgetGate` runs, and a null gate ALLOWS — a build
 * that never initialises it behaves exactly as it did before this existed, which is the same
 * defaulting rule `activePosture` uses.
 */
let activeGate: DesktopBudgetGate | null = null;

export function initBudgetGate(userDataPath: string, pricing?: ai.Pricing): DesktopBudgetGate {
  activeGate = new DesktopBudgetGate(userDataPath);
  if (pricing) activeGate.setPricing(pricing);
  return activeGate;
}

export function getBudgetGate(): DesktopBudgetGate | null {
  return activeGate;
}

/** Adopt resolved settings into the live gate (called wherever the posture is adopted). */
export function setBudgetSettings(s: coreSettings.Settings | undefined): void {
  activeGate?.setSettings(s);
}

/** Test seam: drop the process-wide gate so a suite starts from a known state. */
export function resetBudgetGate(): void {
  activeGate = null;
}
