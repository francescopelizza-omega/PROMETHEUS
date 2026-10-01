// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/secure-cmd.ts — the FULL `prometheus secure …` surface (file 03), at parity
 * with the GUI Security panel: the C4 arbitrary-target gate, the threat-DB, the
 * trust ledger, and remediation. Reads run straight; remediation PREVIEWS first and
 * EXECUTES on `--yes` (with the never-force gate on `--force`). NOTHING here decides
 * "safe" — every verdict is the engine/nemesis result (C5); a fail-closed transport
 * error rides through as a value, never a throw.
 *
 *   secure scan <target>            arbitrary-target gate (alias of `prometheus gate`)  [read]
 *   secure db [status]              threat-DB feed/cache status                   [read]
 *   secure db update [--force][--all]   refresh signature/IOC feeds            [mutate]
 *   secure trust list               remembered trusted sources                    [read]
 *   secure trust log [--blocks][--forced][--last24h]   the audit ledger           [read]
 *   secure trust verify <file>      verify a signed bundle                        [read]
 *   secure trust revoke <name>      clear remembered trust                      [mutate]
 *   secure disinfect <target> --out DIR   neutralize findings → re-scan        [mutate]
 *   secure quarantine [list] [--dir D | --target T]   quarantine listing         [read]
 *   secure quarantine restore <id> --dir D            restore a quarantined item[mutate]
 *   secure audit|verdict|purge …    → the engine subcommands (generic.ts)
 */
import {
  type AuditLogEntry,
  type AuditLogFilter,
  acceptFinding as ebAcceptFinding,
  auditBounds as ebAuditBounds,
  auditLog as ebAuditLog,
  authKey as ebAuthKey,
  cacheStatus as ebCacheStatus,
  clearCache as ebClearCache,
  disinfect as ebDisinfect,
  ignoreList as ebIgnoreList,
  listTrusted as ebListTrusted,
  quarantineList as ebQuarantineList,
  restore as ebRestore,
  revoke as ebRevoke,
  threatDbStatus as ebThreatDbStatus,
  updateFeeds as ebUpdateFeeds,
  verify as ebVerify,
} from "@prometheus/engine-bridge";

import type {
  FusedUrlVerdict,
  NemesisVerdict,
  SecurityVerdict,
  UrlFinding,
  VerdictTier,
} from "@prometheus/engine-bridge";
import { SCAN_STAGE_COUNT, parseStageLine } from "@prometheus/engine-bridge";

import type { CliContext, CommandOutcome } from "../context.js";
import { suppressProgress } from "../context.js";
import { c, heading, kv, table } from "../render.js";
import { renderVerdictCard } from "../verdict-view.js";
import { resolveGateVerdict } from "./gate.js";
import { runGeneric } from "./generic.js";
import {
  flagSet,
  flagStr,
  forceBlocked,
  previewAction,
  usageError,
  wantsExecute,
} from "./sidecar-cmd.js";

/** The engine-bridge security functions, injected so the surface is unit-testable. */
export interface SecureDeps {
  threatDbStatus: typeof ebThreatDbStatus;
  updateFeeds: typeof ebUpdateFeeds;
  listTrusted: typeof ebListTrusted;
  auditLog: typeof ebAuditLog;
  verify: typeof ebVerify;
  revoke: typeof ebRevoke;
  disinfect: typeof ebDisinfect;
  quarantineList: typeof ebQuarantineList;
  restore: typeof ebRestore;
  cacheStatus: typeof ebCacheStatus;
  clearCache: typeof ebClearCache;
  authKey: typeof ebAuthKey;
  ignoreList: typeof ebIgnoreList;
  acceptFinding: typeof ebAcceptFinding;
}

export const defaultSecureDeps: SecureDeps = {
  threatDbStatus: ebThreatDbStatus,
  updateFeeds: ebUpdateFeeds,
  listTrusted: ebListTrusted,
  auditLog: ebAuditLog,
  verify: ebVerify,
  revoke: ebRevoke,
  disinfect: ebDisinfect,
  quarantineList: ebQuarantineList,
  restore: ebRestore,
  cacheStatus: ebCacheStatus,
  clearCache: ebClearCache,
  authKey: ebAuthKey,
  ignoreList: ebIgnoreList,
  acceptFinding: ebAcceptFinding,
};

function sub(ctx: CliContext): string {
  // `unmatchedSub` (parse.ts) is set when a second word WAS typed but didn't match secure's
  // whitelist — without checking it first, that typo silently vanished into `positionals[0]`
  // and this always defaulted to "scan", running a REAL nemesis scan against the literal typo
  // string with no indication the action was unrecognized. Only a genuinely bare `/secure`
  // (no second word at all) still defaults to "scan".
  return ctx.args.unmatchedSub ?? ctx.args.command[1] ?? "scan";
}

/* ── `secure scan`: streamed progress + normalized findings + scripting exit (CLI-040) ── *
 * Exit-code CONTRACT: `secure scan` uses a SCRIPTING map — allow→0, warn→1, block/error→2
 * (error stays fail-closed red). This is DELIBERATELY distinct from `prometheus gate`'s
 * nemesis-mirroring 0/10/20/2 (verdict-view.ts `exitCodeForTier`, which shells branch on and
 * MUST NOT change). The tier→simple map is post-applied here; `exitCodeForTier` is untouched. */

export type SimpleExit = 0 | 1 | 2;

/** The 0/1/2 scripting exit for `secure scan` (allow=0, warn=1, block/error=2). */
export function exitCodeSimple(tier: VerdictTier): SimpleExit {
  switch (tier) {
    case "allow":
      return 0;
    case "warn":
      return 1;
    default:
      return 2; // block | error → fail-closed red (a scanner-missing/timeout error is NOT a pass)
  }
}

export interface ScanFinding {
  /** the finding's class axis (malware/secret/vuln/sca/container) — uniform across both shapes. */
  verdict: string;
  rule: string;
  path: string;
  severity: string;
  excerpt?: string;
}
export interface ScanCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}
export interface NormalizedScan {
  ok: boolean;
  target: string;
  verdict: VerdictTier;
  findings: ScanFinding[];
  counts: ScanCounts;
  exitCode: SimpleExit;
  /** the untouched original verdict, so nothing is lost for debugging. */
  raw: SecurityVerdict | NemesisVerdict;
}

/** Normalize either verdict shape into one scripting-friendly envelope (counts over the FULL set). */
export function normalizeScan(v: SecurityVerdict | NemesisVerdict): NormalizedScan {
  const tier = v.verdict;
  let findings: ScanFinding[];
  const counts: ScanCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  if ("top_findings" in v) {
    findings = (Array.isArray(v.top_findings) ? v.top_findings : []).map((f) => ({
      verdict: String(f.klass ?? ""),
      rule: f.rule_id || f.rule || "",
      path: f.path ?? "",
      severity: String(f.severity ?? "").toLowerCase(),
      ...(f.detail ? { excerpt: f.detail } : {}),
    }));
    // counts come from the engine's FULL severity_counts (not the truncated top_findings).
    const sc = (v.severity_counts ?? {}) as Partial<Record<string, number>>;
    counts.critical = sc.CRITICAL ?? 0;
    counts.high = sc.HIGH ?? 0;
    counts.medium = sc.MEDIUM ?? 0;
    counts.low = sc.LOW ?? 0;
  } else {
    findings = v.findings.map((f) => ({
      verdict: f.klass,
      rule: f.rule,
      path: f.where,
      severity: f.severity,
    }));
    for (const f of v.findings) {
      if (f.severity === "critical") counts.critical++;
      else if (f.severity === "high") counts.high++;
      else if (f.severity === "medium") counts.medium++;
      else if (f.severity === "low") counts.low++;
    }
  }
  return {
    ok: tier === "allow",
    target: v.target,
    verdict: tier,
    findings,
    counts,
    exitCode: exitCodeSimple(tier),
    raw: v,
  };
}

/** The pretty-mode summary footer under the verdict card. */
export function scanFooter(counts: ScanCounts): string {
  const total = counts.critical + counts.high + counts.medium + counts.low;
  if (total === 0) return c.dim("clean — no findings");
  return c.dim(
    `${total} finding${total === 1 ? "" : "s"} — ${counts.critical} critical · ${counts.high} high · ${counts.medium} medium · ${counts.low} low`,
  );
}

/**
 * Build an `onStderr` sink that turns raw nemesis stderr LINES into labeled `[i/N] stage — detail`
 * lines, one per stage TRANSITION (deduped by stage id). `write` is injected so tests can capture
 * the stream; the runtime writes to process.stderr. Silent by construction in --json mode (the
 * caller passes `undefined` instead of this).
 */
export function makeStageStreamer(write: (s: string) => void): (line: string) => void {
  let last = "";
  return (line: string) => {
    if (!line.trim()) return;
    const s = parseStageLine(line);
    if (s.stage === last) return; // dedupe: many stderr lines per phase, one printed line
    last = s.stage;
    const tag = s.index > 0 ? `[${s.index}/${SCAN_STAGE_COUNT}]` : "[·]";
    write(`${tag} ${s.label}${s.detail ? ` — ${s.detail}` : ""}\n`);
  };
}

/** `prometheus secure scan <target>` — the C4 gate with streamed stages + normalized JSON + 0/1/2 exit. */
/**
 * CLI-079: build the audit-log filter from the CLI flags — shared by `secure trust log` AND
 * `gate history` so they query identically. The 4 parameterized filters (`--target`/`--since`/
 * `--until`/`--rule`) AND with the 3 existing booleans (`--blocks`/`--forced`/`--last24h`) and
 * with each other; time bounds intersect `--last24h` (most-restrictive wins).
 */
export function buildAuditFilter(ctx: CliContext): AuditLogFilter {
  const f: AuditLogFilter = {
    blocks: flagSet(ctx, "blocks"),
    forcedDanger: flagSet(ctx, "forced"),
    last24h: flagSet(ctx, "last24h"),
  };
  const target = flagStr(ctx, "target");
  if (target) f.target = target;
  const since = flagStr(ctx, "since");
  if (since) f.since = since;
  const until = flagStr(ctx, "until");
  if (until) f.until = until;
  const rule = flagStr(ctx, "rule");
  if (rule) f.rule = rule;
  return f;
}

/**
 * CLI-079: the ONE audit-log renderer both `secure trust log` and `gate history` call — so they
 * are provably the same code path, not two renderers that drift. `--json` echoes the applied
 * filter + the RESOLVED time bounds alongside the (unchanged) `entries` array (deliverable 4).
 */
export function renderAuditLog(
  json: boolean,
  filter: AuditLogFilter,
  rows: AuditLogEntry[],
): CommandOutcome {
  if (json) {
    return {
      json: { ok: true, filter, bounds: ebAuditBounds(filter), entries: rows },
      exitCode: 0,
    };
  }
  const lines = [heading(`Audit log  ${c.dim(`(${rows.length})`)}`), ""];
  if (rows.length === 0) lines.push(c.dim("No matching audit entries."));
  else {
    const trows = rows.slice(0, 50).map((e) => {
      const rec = e as unknown as Record<string, unknown>;
      const v = String(rec.verdict ?? "—");
      const badge = v === "allow" ? c.green(v) : v === "warn" ? c.yellow(v) : c.red(v);
      return [c.dim(String(rec.at ?? "")), badge, String(rec.target ?? rec.name ?? "")];
    });
    lines.push(table([{ header: "WHEN" }, { header: "VERDICT" }, { header: "TARGET" }], trows));
  }
  return { text: lines.join("\n"), exitCode: 0 };
}

/* ── CLI-080: URL-injection L0-L6 layer trace (`secure <target> --explain`) ─────────── */

const URL_RULES = new Set(["URL-IPI", "URL-CLOAK", "URL-OPAQUE", "URL-RUGPULL", "URL-DRIFT"]);
const LAYER_LABEL: Record<string, string> = {
  L0: "L0  opaque encoded-URL blobs",
  L3: "L3  cloaking probe (rendered-vs-raw divergence)",
  L4: "L4  content classifier",
  L6: "L6  fetched-content signals",
};

/** Neutralize any live http(s) URL in the explain text so DISPLAYING the trace never re-introduces
 *  a clickable/actionable URL into the terminal/scrollback (URL-inertness is the whole point). */
export function defangDisplay(s: string): string {
  return s.replace(/\bhttps?:\/\/[^\s'"<>]+/gi, (u) =>
    u.replace(/^http/i, "hxxp").replace(/\./g, "[.]"),
  );
}

/** Which defense-in-depth layer a URL finding belongs to (URL-IPI is emitted by both L4 + L6). */
function layerOf(f: UrlFinding): "L0" | "L3" | "L4" | "L6" {
  if (f.rule_id === "URL-OPAQUE") return "L0";
  if (f.rule_id === "URL-CLOAK") return "L3";
  if (f.rule_id === "URL-IPI") return /fetched|injection in fetched/i.test(f.detail) ? "L6" : "L4";
  return "L6"; // URL-RUGPULL / URL-DRIFT are fetch-time signals
}

/** True when `v` already IS a FusedUrlVerdict (a stored verdict_full, or a fresh fuse result). */
function isFusedVerdict(v: unknown): v is FusedUrlVerdict {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    (r.tier === "allow" || r.tier === "warn" || r.tier === "block") &&
    Array.isArray(r.findings) &&
    Array.isArray(r.reasons) &&
    typeof r.degraded === "boolean"
  );
}

/**
 * CLI-080: project a data source into ONE FusedUrlVerdict for the explain renderer — a stored
 * `verdict_full` that already IS a FusedUrlVerdict passes through UNTOUCHED (so `--json --explain`
 * emits the real fusion); a live scan verdict has its URL-* findings extracted from `top_findings`
 * (no re-scan / no extra fetch — we render the fusion the normal scan already computed). Two data
 * sources, one renderer.
 */
export function projectFusedVerdict(source: unknown): FusedUrlVerdict {
  if (isFusedVerdict(source)) return source; // stored verdict_full / fuse result — untouched
  const rec = (source ?? {}) as Record<string, unknown>;
  const tf = Array.isArray(rec.top_findings) ? (rec.top_findings as Record<string, unknown>[]) : [];
  const findings: UrlFinding[] = [];
  for (const f of tf) {
    const rule = String(f.rule_id ?? f.rule ?? "");
    if (!URL_RULES.has(rule)) continue;
    const sev = String(f.severity ?? "").toUpperCase();
    findings.push({
      rule_id: rule as UrlFinding["rule_id"],
      severity: sev === "HIGH" || sev === "CRITICAL" ? "HIGH" : "MEDIUM",
      klass: "malware",
      category: rule === "URL-OPAQUE" ? "obfuscation" : "ioc",
      path: String(f.path ?? f.where ?? rec.target ?? ""),
      detail: String(f.detail ?? ""),
      ...(typeof f.evidence === "string" ? { evidence: f.evidence } : {}),
    });
  }
  // tier reflects the URL-injection signal ONLY (a non-URL block is not a URL verdict).
  const hasHigh = findings.some((f) => f.severity === "HIGH");
  const tier: FusedUrlVerdict["tier"] = hasHigh ? "block" : findings.length ? "warn" : "allow";
  const reasons = findings
    .filter((f) => f.severity === "HIGH")
    .map((f) => `${f.rule_id}: ${f.detail}`);
  return { tier, findings, degraded: rec.degraded === true, reasons };
}

/**
 * CLI-080: the ONE human renderer for a URL-injection trace — grouped by defense-in-depth layer
 * (L0 opaque → L3 cloak → L4 classifier → L6 fetch), HIGH-first within a layer, evidence DEFANGED.
 * A `degraded` fusion gets a distinct own-line caveat (never a hidden footnote). Reused for a live
 * scan AND a stored `verdict_full` (deliverable 2).
 */
export function renderUrlExplain(v: FusedUrlVerdict): string {
  const tierBadge =
    v.tier === "allow" ? c.green(v.tier) : v.tier === "warn" ? c.yellow(v.tier) : c.red(v.tier);
  const lines = [heading("URL-injection layer trace"), "", kv("verdict tier", tierBadge)];
  if (v.degraded) {
    lines.push(
      c.yellow(
        "⚠ DEGRADED — a layer signal was unavailable/heuristic-only (e.g. the L4 classifier ran " +
          "heuristic-only); this verdict is based on the remaining layers, NOT a full-confidence scan.",
      ),
    );
  }
  if (v.reasons.length) {
    lines.push("", c.dim("reasons:"));
    for (const r of v.reasons) lines.push(`  - ${defangDisplay(r)}`);
  }
  for (const layer of ["L0", "L3", "L4", "L6"] as const) {
    const group = v.findings
      .filter((f) => layerOf(f) === layer)
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "HIGH" ? -1 : 1));
    lines.push("", c.bold(LAYER_LABEL[layer] ?? layer));
    if (group.length === 0) {
      lines.push(c.dim("  (no signal)"));
      continue;
    }
    for (const f of group) {
      const sevBadge = f.severity === "HIGH" ? c.red(f.severity) : c.yellow(f.severity);
      lines.push(`  [${sevBadge}] ${f.rule_id}  ${defangDisplay(f.detail)}`);
      if (f.evidence) lines.push(c.dim(`      evidence: ${defangDisplay(f.evidence)}`));
    }
  }
  return lines.join("\n");
}

async function runSecureScan(ctx: CliContext): Promise<CommandOutcome> {
  const target = ctx.args.positionals[0];
  if (!target) return usageError("secure scan", "<path | git-url | owner/repo>");
  // progress on stderr only (never stdout — a --json consumer pipes stdout); silent in --json AND
  // under --quiet (CLI-085: progress ticks are cosmetic chatter, not a result or a safety signal).
  const onStderr = suppressProgress(ctx)
    ? undefined
    : makeStageStreamer((s) => {
        process.stderr.write(s);
      });
  const verdict = await resolveGateVerdict(ctx, onStderr);
  const norm = normalizeScan(verdict);
  // CLI-080: `--explain` renders the URL-injection L0-L6 trace over the SAME scan (no extra
  // fetch/probe) — additive read-only rendering; the verdict/exit code are unchanged.
  if (flagSet(ctx, "explain")) {
    const fused = projectFusedVerdict(verdict);
    // `ok` must reflect the OVERALL scan verdict (which drives exitCode), NOT the URL sub-tier —
    // else a scan that BLOCKS on a non-URL finding would report ok:true alongside a non-zero exit.
    if (ctx.json) return { json: { ...fused, ok: norm.exitCode === 0 }, exitCode: norm.exitCode };
    return {
      text: `${renderVerdictCard(verdict)}\n\n${renderUrlExplain(fused)}`,
      exitCode: norm.exitCode,
    };
  }
  if (ctx.json) return { json: { ...norm }, exitCode: norm.exitCode };
  return {
    text: `${renderVerdictCard(verdict)}\n\n${scanFooter(norm.counts)}`,
    exitCode: norm.exitCode,
  };
}

export async function runSecureCommand(
  ctx: CliContext,
  deps: SecureDeps = defaultSecureDeps,
): Promise<CommandOutcome> {
  const verb = sub(ctx);
  switch (verb) {
    // the engine subcommands keep their existing generic routing.
    case "audit":
    case "verdict":
    case "purge":
      return runGeneric(["secure", verb], ctx);

    case "scan":
      // the arbitrary-target gate (C4) — streamed stage progress + normalized findings +
      // the 0/1/2 scripting exit map (distinct from `prometheus gate`'s 0/10/20/2).
      return runSecureScan(ctx);

    case "db":
      return runDb(ctx, deps);
    case "trust":
      return runTrust(ctx, deps);
    case "disinfect":
      return runDisinfect(ctx, deps);
    case "quarantine":
      return runQuarantine(ctx, deps);
    case "ignore":
    case "accept":
      return runIgnore(ctx, deps);

    default:
      return {
        text:
          `prometheus secure ${verb}: unknown secure verb.\n` +
          `  ${c.dim("try:")} scan · db · trust · disinfect · quarantine · ignore · accept · audit · verdict · purge`,
        json: { ok: false, error: "unknown-verb", command: `secure ${verb}` },
        exitCode: 1,
      };
  }
}

/* ------------------------------- db --------------------------------------- */

async function runDb(ctx: CliContext, deps: SecureDeps): Promise<CommandOutcome> {
  const action = ctx.args.positionals[0] ?? "status";
  if (action === "status") {
    const s = await deps.threatDbStatus({});
    if (ctx.json) return { json: { ...s }, exitCode: s.ok === false ? 2 : 0 };
    const lines = [heading("Threat-DB"), ""];
    lines.push(kv("status", s.ok === false ? c.red("unavailable") : c.green("ok")));
    const rec = s as unknown as Record<string, unknown>;
    for (const k of ["indicators", "feeds", "loaded", "age", "cache"]) {
      if (rec[k] !== undefined) lines.push(kv(k, c.dim(String(rec[k]))));
    }
    if (typeof rec.error === "string") lines.push(kv("note", c.dim(rec.error)));
    return { text: lines.join("\n"), exitCode: s.ok === false ? 2 : 0 };
  }
  if (action === "update") {
    const blocked = forceBlocked(ctx, "secure db update");
    if (blocked) return blocked;
    if (!wantsExecute(ctx)) {
      return previewAction(
        "secure db update",
        "refresh the threat-DB signature/IOC feeds (network)",
      );
    }
    const res = await deps.updateFeeds({ force: ctx.args.force, all: flagSet(ctx, "all") });
    if (ctx.json) return { json: { ...res }, exitCode: res.ok ? 0 : 2 };
    return res.ok
      ? { text: `${c.green("✓")} threat-DB updated\n${c.dim(res.summary)}`, exitCode: 0 }
      : { text: c.red(`secure db update failed: ${res.error ?? "unknown"}`), exitCode: 2 };
  }

  if (action === "cache") {
    const op = ctx.args.positionals[1] ?? "status";
    if (op === "clear") {
      const blocked = forceBlocked(ctx, "secure db cache clear");
      if (blocked) return blocked;
      if (!wantsExecute(ctx)) {
        return previewAction(
          "secure db cache clear",
          "delete the nemesis verdict cache (forces fresh re-scans)",
        );
      }
      const res = await deps.clearCache({});
      if (ctx.json) return { json: { ...res }, exitCode: res.ok ? 0 : 2 };
      return res.ok
        ? { text: `${c.green("✓")} verdict cache cleared\n${c.dim(res.message)}`, exitCode: 0 }
        : { text: c.red(`cache clear failed: ${res.error ?? "unknown"}`), exitCode: 2 };
    }
    const s = await deps.cacheStatus({});
    if (ctx.json) return { json: { ...s }, exitCode: s.ok ? 0 : 2 };
    const lines = [heading("Verdict cache"), ""];
    lines.push(kv("status", s.ok ? c.green("ok") : c.red("unavailable")));
    if (s.entries !== null) lines.push(kv("entries", String(s.entries)));
    if (s.status) lines.push(kv("detail", c.dim(s.status)));
    if (s.error) lines.push(kv("note", c.dim(s.error)));
    return { text: lines.join("\n"), exitCode: s.ok ? 0 : 2 };
  }

  if (action === "auth") {
    // The DB auth key is a SECRET. Prefer an env var so it is never in shell
    // history / process argv; --key is accepted but discouraged. The engine-bridge
    // authKey() scrubs the key from any error/stderr. Mutating → preview/confirm.
    const key = flagStr(ctx, "key") ?? process.env.NEMESIS_AUTH_KEY ?? process.env.PROM_NEMESIS_KEY;
    if (!key) {
      return usageError(
        "secure db auth",
        "--key <KEY>  (better: set NEMESIS_AUTH_KEY to avoid argv/history leak)",
      );
    }
    const blocked = forceBlocked(ctx, "secure db auth");
    if (blocked) return blocked;
    if (!wantsExecute(ctx)) {
      return previewAction(
        "secure db auth",
        "register the threat-DB auth key (enables authenticated feed pulls)",
      );
    }
    const res = await deps.authKey(key, {});
    if (ctx.json)
      return { json: { ok: res.ok, error: res.error ?? null }, exitCode: res.ok ? 0 : 2 };
    return res.ok
      ? { text: `${c.green("✓")} threat-DB auth key registered`, exitCode: 0 }
      : { text: c.red(`auth failed: ${res.error ?? "unknown"}`), exitCode: 2 };
  }

  return usageError("secure db", "[status | update | cache [status|clear] | auth --key <KEY>]");
}

/* ------------------------------ ignore / accept --------------------------- */

async function runIgnore(ctx: CliContext, deps: SecureDeps): Promise<CommandOutcome> {
  const verb = ctx.args.command[1]; // "ignore" | "accept"
  // `secure ignore list` (read) — the per-finding accept entries the gate honours.
  if (verb === "ignore") {
    const action = ctx.args.positionals[0] ?? "list";
    if (action !== "list") return usageError("secure ignore", "list");
    const res = await deps.ignoreList({});
    if (ctx.json) return { json: { ...res }, exitCode: res.ok ? 0 : 2 };
    const lines = [heading("Ignored findings (accepted)"), ""];
    lines.push(res.ok ? res.listing.trim() || c.dim("(none)") : c.red(res.error ?? "unavailable"));
    return { text: lines.join("\n"), exitCode: res.ok ? 0 : 2 };
  }

  // `secure accept <target> --rule <id> --path <path>` — HONEST LIMIT: nemesis 1.12
  // has no non-interactive ignore-add; accept is created via the interactive scan
  // [i]gnore decision. We surface that truthfully rather than silently no-op.
  const target = ctx.args.positionals[0];
  const rule = flagStr(ctx, "rule");
  const path = flagStr(ctx, "path");
  if (!target || !rule || !path) {
    return usageError("secure accept", "<target> --rule <ruleId> --path <path>");
  }
  const res = deps.acceptFinding(target, rule, path);
  if (ctx.json) return { json: { ...res }, exitCode: res.supported ? 0 : 2 };
  return {
    text:
      `${c.yellow("⚠")} secure accept — ${c.dim("not scriptable in this nemesis build")}\n` +
      `  ${c.dim(res.reason)}\n` +
      `  ${c.dim("read current accepts with")} ${c.bold("prometheus secure ignore list")}`,
    exitCode: 2,
  };
}

/* ------------------------------ trust ------------------------------------- */

async function runTrust(ctx: CliContext, deps: SecureDeps): Promise<CommandOutcome> {
  const action = ctx.args.positionals[0] ?? "list";

  if (action === "list") {
    const rows = deps.listTrusted();
    if (ctx.json) return { json: { ok: true, trusted: rows }, exitCode: 0 };
    const lines = [heading(`Trusted sources  ${c.dim(`(${rows.length})`)}`), ""];
    if (rows.length === 0) lines.push(c.dim("No remembered trust."));
    else {
      const trows = rows.map((r) => {
        const rec = r as unknown as Record<string, unknown>;
        return [String(rec.name ?? "—"), c.dim(String(rec.at ?? rec.scope ?? ""))];
      });
      lines.push(table([{ header: "NAME" }, { header: "WHEN / SCOPE" }], trows));
    }
    return { text: lines.join("\n"), exitCode: 0 };
  }

  if (action === "log") {
    const filter = buildAuditFilter(ctx);
    return renderAuditLog(ctx.json, filter, deps.auditLog(filter));
  }

  if (action === "verify") {
    const file = ctx.args.positionals[1];
    if (!file) return usageError("secure trust verify", "<file>");
    const res = await deps.verify(file, {});
    if (ctx.json) return { json: { ...res, ok: res.valid }, exitCode: res.valid ? 0 : 2 };
    return res.valid
      ? { text: `${c.green("✓")} verified — ${res.message}`, exitCode: 0 }
      : { text: c.red(`✗ NOT verified — ${res.message}`), exitCode: 2 };
  }

  if (action === "revoke") {
    const name = ctx.args.positionals[1];
    if (!name) return usageError("secure trust revoke", "<name>");
    const blocked = forceBlocked(ctx, "secure trust revoke");
    if (blocked) return blocked;
    if (!wantsExecute(ctx)) {
      return previewAction("secure trust revoke", `clear remembered trust for '${name}'`);
    }
    const res = await deps.revoke(name, {});
    if (ctx.json) return { json: { ...res }, exitCode: res.ok ? 0 : 2 };
    return res.ok
      ? { text: `${c.green("✓")} trust revoked for ${name}`, exitCode: 0 }
      : { text: c.red(`revoke failed: ${res.error ?? "unknown"}`), exitCode: 2 };
  }

  return usageError("secure trust", "[list | log | verify <file> | revoke <name>]");
}

/* ---------------------------- disinfect ----------------------------------- */

async function runDisinfect(ctx: CliContext, deps: SecureDeps): Promise<CommandOutcome> {
  const target = ctx.args.positionals[0];
  const out = flagStr(ctx, "out");
  if (!target || !out) return usageError("secure disinfect", "<target> --out <dir>");
  const blocked = forceBlocked(ctx, "secure disinfect");
  if (blocked) return blocked;
  if (!wantsExecute(ctx)) {
    return previewAction(
      "secure disinfect",
      `neutralize solvable findings in ${target}, quarantine hard malware → cleaned copy in ${out}, then re-scan`,
    );
  }
  const res = await deps.disinfect(target, { out });
  if (ctx.json) return { json: { ...res }, exitCode: res.ok ? 0 : 2 };
  const lines = [heading(`Disinfect  ${c.dim(target)}`), ""];
  const v = res.verdict?.verdict ?? "error";
  lines.push(kv("post-scan", v === "allow" ? c.green(v) : v === "warn" ? c.yellow(v) : c.red(v)));
  lines.push(kv("resolved", c.green(String(res.resolved.length))));
  lines.push(
    kv("unresolved", res.unresolved.length ? c.red(String(res.unresolved.length)) : c.dim("0")),
  );
  lines.push(kv("cleaned copy", c.dim(res.output)));
  for (const e of res.errors) lines.push(c.red(`  ! ${e}`));
  return { text: lines.join("\n"), exitCode: res.ok ? 0 : 2 };
}

/* --------------------------- quarantine ----------------------------------- */

async function runQuarantine(ctx: CliContext, deps: SecureDeps): Promise<CommandOutcome> {
  const action = ctx.args.positionals[0] === "restore" ? "restore" : "list";
  const dir = flagStr(ctx, "dir");
  const target = flagStr(ctx, "target");

  if (action === "restore") {
    const id = ctx.args.positionals[1];
    if (!id || !dir) return usageError("secure quarantine restore", "<id> --dir <quarantine-dir>");
    const blocked = forceBlocked(ctx, "secure quarantine restore");
    if (blocked) return blocked;
    if (!wantsExecute(ctx)) {
      return previewAction(
        "secure quarantine restore",
        `restore quarantined item '${id}' from ${dir}`,
      );
    }
    const res = await deps.restore(id, { quarantineDir: dir });
    if (ctx.json) return { json: { ...res }, exitCode: res.ok ? 0 : 2 };
    return res.ok
      ? { text: `${c.green("✓")} restored ${id}\n${c.dim(res.message)}`, exitCode: 0 }
      : { text: c.red(`restore failed: ${res.error ?? "unknown"}`), exitCode: 2 };
  }

  // list (the `restore` positional is consumed above; here positional[0] may be "list" or absent)
  const res = await deps.quarantineList({
    ...(dir ? { quarantineDir: dir } : {}),
    ...(target ? { target } : {}),
  });
  if (ctx.json) return { json: { ...res }, exitCode: res.ok === false ? 2 : 0 };
  if (res.ok === false) {
    return {
      text: c.red(`secure quarantine: ${res.error ?? "no quarantine dir or --target given"}`),
      exitCode: 2,
    };
  }
  const lines = [heading("Quarantine"), "", kv("dir", c.dim(res.quarantineDir))];
  lines.push("");
  lines.push(res.listing.trim() || c.dim("(empty)"));
  return { text: lines.join("\n"), exitCode: 0 };
}
