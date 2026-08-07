/**
 * commands/tokens.ts — `prometheus tokens`: the token-saving toolkit Prometheus proposes
 * to cut $ on paid closed models + compute on free local LLMs. Pure read over the
 * core `tokenEconomy` registry; no engine call, no gating.
 *
 *   prometheus tokens                 the default proposals (low-friction, high-value)
 *   prometheus tokens --paid          tailored for a paid closed model ($ savings first)
 *   prometheus tokens all             the full menu (every technique, incl. opt-in)
 *   prometheus tokens <id>            detail for one tool (install + usage + tradeoff)
 *   prometheus tokens nano            the honest Gemini-Nano local-feasibility assessment
 */
import { loadPricing, tokenEconomy } from "@prometheus/core";

import type { CliContext, CommandOutcome } from "../context.js";
import { prometheusHome } from "../home.js";
import { c, heading, kv } from "../render.js";
import { latestAccountingSession, readAccounting } from "../session/history-store.js";
import { isTokenEnabled, readTokenToggles, setTokenToggle } from "./token-toggles.js";
import { type CacheEconomyReport, buildCacheReport } from "./tokens-report.js";

/** CLI-088: `prometheus tokens enable|disable <id>` — validate the id, persist the toggle, and label the
 *  wired/advisory reality (enabling an advisory technique persists but warns it has no runtime effect). */
function runTokenToggle(ctx: CliContext, verb: "enable" | "disable"): CommandOutcome {
  // action can arrive as command[1] or positionals[0]; the id is the NEXT positional either way.
  const fromCommand = ctx.args.command[1] !== undefined;
  const id = (fromCommand ? ctx.args.positionals[0] : ctx.args.positionals[1]) ?? "";
  const tool = tokenEconomy.getTokenTool(id);
  if (!tool) {
    const ids = tokenEconomy.TOKEN_TOOLS.map((t) => t.id);
    const near =
      ids.find((x) => id && (x.includes(id) || id.includes(x))) ??
      ids.find((x) => id && x[0] === id[0]);
    const msg = `unknown technique: ${id || "(none)"}${near ? ` — did you mean '${near}'?` : ""}. See: prometheus tokens all`;
    return { text: c.red(msg), json: { ok: false, error: msg }, exitCode: 1 };
  }
  const enabled = verb === "enable";
  setTokenToggle(tool.id, enabled);
  const wiring = tokenEconomy.tokenWiring(tool.id);
  const advisory = wiring === "advisory";
  if (ctx.json) {
    return { json: { ok: true, id: tool.id, enabled, wiring }, exitCode: 0 };
  }
  const head = enabled ? c.green("✓ enabled") : c.dim("○ disabled");
  const note =
    enabled && advisory
      ? c.yellow(
          ` — advisory: no runtime effect (apply it yourself; detail: prometheus tokens ${tool.id})`,
        )
      : "";
  return { text: `${head} ${c.bold(tool.name)} ${c.dim(`[${wiring}]`)}${note}`, exitCode: 0 };
}

/** Compact token count: 12300 → "12.3k", <1000 → "N". */
function kTok(n: number): string {
  if (n < 1000) return `${Math.floor(n)}`;
  const k = n / 1000;
  return k >= 100 ? `${Math.floor(k)}k` : `${(Math.floor(k * 10) / 10).toFixed(1)}k`;
}

/** USD, clearly an estimate: sub-cent gets 4 decimals so a real-but-tiny saving isn't shown as $0.00. */
function estUsd(n: number): string {
  return n > 0 && n < 0.01 ? `~$${n.toFixed(4)}` : `~$${n.toFixed(2)}`;
}

/**
 * CLI-090: `prometheus tokens report` — MEASURED effectiveness of the token-economy techniques for THIS
 * session (the latest accounting file). Reads the cache counters CLI-029 now records; techniques
 * with no runtime signal are labeled "advisory only" rather than shown as a fabricated 0.
 */
function runTokensReport(ctx: CliContext): CommandOutcome {
  const home = prometheusHome();
  const sessionId = latestAccountingSession(home);
  const records = sessionId ? readAccounting(home, sessionId) : [];
  const toggles = readTokenToggles();
  const report = buildCacheReport(records, toggles, loadPricing(), sessionId);

  if (ctx.json) {
    // raw counters (not just the human summary) for scripting/telemetry — deliverable 3.
    return {
      json: {
        ok: true,
        sessionId: report.sessionId,
        turns: report.turns,
        measurable: report.measurable,
        raw: report.raw,
        techniques: report.techniques,
      },
      exitCode: 0,
    };
  }
  return { text: renderReport(report).join("\n"), exitCode: 0 };
}

function renderReport(r: CacheEconomyReport): string[] {
  const lines = [heading("Token-economy report — measured effectiveness"), ""];
  lines.push(
    kv("session", r.sessionId ? c.dim(r.sessionId) : c.dim("(none — no accounting captured yet)")),
  );
  lines.push(
    kv(
      "turns",
      `${c.bold(String(r.turns))}  ${c.dim(`· prompt ${kTok(r.raw.promptTokens)} · completion ${kTok(r.raw.completionTokens)} tok`)}`,
    ),
  );
  lines.push("");

  // measured + enabled + wired techniques get their own line; the advisory remainder is summarized.
  const own = r.techniques.filter((t) => t.measured || t.enabled || t.wiring === "wired");
  const rest = r.techniques.filter((t) => !(t.measured || t.enabled || t.wiring === "wired"));

  for (const t of own) {
    const on = t.enabled ? c.green("ON ") : c.dim("off");
    const wire = t.wiring === "wired" ? c.cyan("[wired]") : c.dim("[advisory]");
    lines.push(`${on} ${wire} ${c.bold(t.name)}`);
    if (t.measured) {
      const parts = [`cache-read ${c.green(`${kTok(t.cacheReadTokens ?? 0)} tok`)}`];
      if ((t.cacheCreateTokens ?? 0) > 0)
        parts.push(`cache-write ${kTok(t.cacheCreateTokens ?? 0)} tok`);
      parts.push(
        t.estSavedUsd == null
          ? c.dim("est saved: n/a (model unpriced)")
          : `est saved ${c.green(estUsd(t.estSavedUsd))} ${c.dim("(estimate)")}`,
      );
      lines.push(`  ${parts.join(c.dim(" · "))}`);
    } else if (t.note) {
      lines.push(`  ${c.dim(t.note)}`);
    }
  }
  if (rest.length > 0) {
    lines.push("");
    lines.push(c.dim(`+ ${rest.length} other techniques: advisory only (no runtime measurement)`));
  }
  lines.push("");
  lines.push(
    c.dim(
      r.measurable
        ? "$ saved is an ESTIMATE from the CLI-058 pricing table · raw counters: prometheus tokens report --json"
        : "no cache-read data captured this session (provider may not expose it) · prometheus tokens report --json",
    ),
  );
  return lines;
}

const SAVES_TINT: Record<string, (s: string) => string> = {
  input: c.cyan,
  output: c.green,
  both: c.magenta,
};

function bestForBadge(bestFor: string): string {
  return bestFor === "paid-closed"
    ? c.red("$ paid")
    : bestFor === "free-local"
      ? c.green("local")
      : c.blue("both");
}

export function runTokens(ctx: CliContext): CommandOutcome {
  const action = ctx.args.command[1] ?? ctx.args.positionals[0] ?? "list";

  // CLI-088: enable/disable BEFORE the getTokenTool(action) lookup (else a bare id would shadow the verb).
  if (action === "enable" || action === "disable") return runTokenToggle(ctx, action);

  if (action === "report") return runTokensReport(ctx); // CLI-090: measured effectiveness

  if (action === "nano") return renderNano(ctx);

  // a specific tool id?
  const tool = tokenEconomy.getTokenTool(action);
  if (tool) {
    if (ctx.json) {
      return {
        json: {
          ok: true,
          tool: {
            ...tool,
            enabled: isTokenEnabled(tool.id),
            wiring: tokenEconomy.tokenWiring(tool.id),
          },
        },
        exitCode: 0,
      };
    }
    const lines = [heading(tool.name), ""];
    lines.push(kv("category", c.dim(tool.category)));
    lines.push(kv("saves", (SAVES_TINT[tool.saves] ?? c.dim)(tool.saves)));
    lines.push(kv("best for", bestForBadge(tool.bestFor)));
    lines.push(kv("maturity", c.dim(tool.maturity)));
    lines.push("");
    lines.push(c.bold("pitch"), `  ${tool.pitch}`);
    lines.push(c.bold("saving"), `  ${c.dim(tool.tokenSaving)}`);
    if (tool.install) lines.push(c.bold("install"), `  ${c.cyan(tool.install)}`);
    lines.push(c.bold("usage"), `  ${c.dim(tool.usage)}`);
    lines.push(c.bold("tradeoff"), `  ${c.yellow(tool.notes)}`);
    return { text: lines.join("\n"), exitCode: 0 };
  }

  const full = action === "all";
  const paid = full ? false : ctx.args.flags.paid === true;
  const tools = tokenEconomy.proposeToolkits({ usingPaidModel: paid, includeOptIn: full });

  const toggles = readTokenToggles();
  if (ctx.json) {
    // CLI-088: each tool carries its `enabled` state + static `wiring` label.
    const enriched = tools.map((t) => ({
      ...t,
      enabled: toggles[t.id] === true,
      wiring: tokenEconomy.tokenWiring(t.id),
    }));
    return {
      json: { ok: true, mode: full ? "all" : paid ? "paid" : "default", tools: enriched },
      exitCode: 0,
    };
  }

  const title = full ? "Token-saving toolkit (full menu)" : "Token-saving toolkit — proposed";
  const lines = [heading(`${title}  ${c.dim(`(${tools.length})`)}`), ""];
  if (tools.length === 0) {
    lines.push(c.dim("No token-saving tools proposed."));
    return { text: lines.join("\n"), exitCode: 0 };
  }
  if (!full) {
    lines.push(c.dim(tokenEconomy.proposeHeadline(paid)));
    lines.push("");
  }
  for (const t of tools) {
    const star = t.defaultOn ? c.green("★") : c.dim("·");
    const saves = (SAVES_TINT[t.saves] ?? c.dim)(t.saves);
    // CLI-088: an ON/off state column + the wired/advisory honesty label.
    const on = toggles[t.id] === true ? c.green("ON ") : c.dim("off");
    const wire = tokenEconomy.tokenWiring(t.id);
    const wireBadge = wire === "wired" ? c.cyan("[wired]") : c.dim("[advisory]");
    lines.push(
      `${star} ${on} ${wireBadge} ${c.bold(t.name)}  ${c.dim(`[${t.category}]`)} ${bestForBadge(t.bestFor)} · saves ${saves}`,
    );
    lines.push(`  ${c.dim(t.pitch)}`);
    lines.push(`  ${c.dim("→")} ${c.dim(t.tokenSaving)}`);
    lines.push(`  ${c.dim(`detail: prometheus tokens ${t.id}`)}`);
  }
  lines.push("");
  lines.push(
    c.dim(
      full
        ? "★ = proposed by default · detail: prometheus tokens <id> · Gemini Nano: prometheus tokens nano"
        : "full menu: prometheus tokens all · for a paid model: prometheus tokens --paid · Gemini Nano: prometheus tokens nano",
    ),
  );
  return { text: lines.join("\n"), exitCode: 0 };
}

function renderNano(ctx: CliContext): CommandOutcome {
  const n = tokenEconomy.GEMINI_NANO;
  if (ctx.json) return { json: { ok: true, geminiNano: n }, exitCode: 0 };
  const feasTint = n.feasible === "yes" ? c.green : n.feasible === "partial" ? c.yellow : c.red;
  const lines = [
    heading(`Gemini Nano — local feasibility  ${feasTint(n.feasible.toUpperCase())}`),
    "",
  ];
  lines.push(kv("account required", n.accountRequired ? c.red("yes") : c.green("no")));
  lines.push(kv("fully local", n.localOnly ? c.green("yes") : c.red("no")));
  lines.push(
    kv(
      "weights downloadable",
      n.weightsRedistributable
        ? c.green("yes")
        : c.red("NO (proprietary — Prometheus will not extract/redistribute)"),
    ),
  );
  lines.push("");
  lines.push(c.bold("paths"));
  for (const m of n.methods) {
    const mark = m.endorsed ? c.green("✓") : c.red("✗");
    lines.push(`  ${mark} ${c.bold(m.method)} ${c.dim(`(${m.reliability})`)}`);
    lines.push(`     ${c.dim(m.tosLegal)}`);
  }
  lines.push("");
  lines.push(c.bold("recommended open ~4GB alternatives (account-free, license-clean)"));
  for (const a of n.alternatives) {
    lines.push(`  ${c.green("●")} ${a.label}  ${c.dim(`· prometheus model info ${a.id}`)}`);
  }
  lines.push("");
  lines.push(c.dim(n.recommendation));
  return { text: lines.join("\n"), exitCode: 0 };
}
