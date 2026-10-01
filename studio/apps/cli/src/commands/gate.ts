// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/gate.ts — `prometheus gate <target>`: gate an arbitrary path / git URL /
 * owner-repo through nemesis (C4) and RENDER the verdict (C5).
 *
 * The CLI never decides "safe": it calls client.gate(), which fail-closes a
 * missing/timed-out/unparseable scanner to verdict "error". The PROCESS EXIT
 * CODE mirrors the tier (allow 0 / warn 10 / block 20 / error 2) so callers and
 * shells can branch on it.
 */
import type { NemesisVerdict, SecurityVerdict } from "@prometheus/engine-bridge";
import { auditLog as ebAuditLog, gateFull } from "@prometheus/engine-bridge";

import type { CliContext, CommandOutcome } from "../context.js";
import { suppressProgress } from "../context.js";
import { c } from "../render.js";
import { exitCodeForTier, renderVerdictCard } from "../verdict-view.js";
import { buildAuditFilter, renderAuditLog } from "./secure-cmd.js";
import { flagSet, flagStr } from "./sidecar-cmd.js";

/** The rich-gate flags route through gateFull() (the FULL NemesisVerdict path). */
function wantsRichGate(ctx: CliContext): boolean {
  return (
    flagSet(ctx, "fresh") ||
    flagSet(ctx, "sign") ||
    flagSet(ctx, "policy") ||
    flagStr(ctx, "tier") === "pentest"
  );
}

/**
 * Resolve a gate verdict for the current target (shared by `prometheus gate` and `prometheus secure scan`).
 * Picks the light `client.gate` (default) or the rich `gateFull` (--fresh/--sign/--policy/--tier)
 * path and threads an optional `onStderr` progress sink. Fail-closed exactly as each path is.
 */
export async function resolveGateVerdict(
  ctx: CliContext,
  onStderr?: (line: string) => void,
): Promise<SecurityVerdict | NemesisVerdict> {
  const target = ctx.args.positionals[0] ?? "";
  if (wantsRichGate(ctx)) {
    return gateFull(target, {
      fresh: flagSet(ctx, "fresh"),
      sign: flagSet(ctx, "sign"),
      tier: flagStr(ctx, "tier") === "pentest" ? "pentest" : "default",
      ...(flagStr(ctx, "policy") ? { policyFile: flagStr(ctx, "policy") } : {}),
      ...(onStderr ? { onStderr } : {}),
    });
  }
  return ctx.client.gate(target, onStderr ? { onStderr } : {});
}

export async function runGate(ctx: CliContext): Promise<CommandOutcome> {
  const target = ctx.args.positionals[0];
  // CLI-079: `prometheus gate history [flags]` is a thin ALIAS for `prometheus secure trust log` — same
  // filter, same renderer (imported, not re-implemented), so the two are provably one code path.
  if (target === "history") {
    const filter = buildAuditFilter(ctx);
    return renderAuditLog(ctx.json, filter, ebAuditLog(filter));
  }
  if (!target) {
    return {
      text: c.red(
        "usage: prometheus gate <path|git-url|owner/repo> [--fresh] [--sign] [--policy <file>] [--tier pentest]",
      ),
      // Bad args are class 1 (CLI-084); 2 is reserved for a nemesis BLOCK, which is exactly
      // what THIS command reports when it does run — so the two must not share a code.
      json: {
        ok: false,
        error: "missing-argument",
        command: "gate",
        usage: "<path|git-url|owner/repo>",
      },
      exitCode: 1,
    };
  }

  // Stream nemesis progress (stderr) to our stderr when pretty + TTY, so a long
  // scan isn't a silent hang. Never to stdout (keeps --json clean).
  const onStderr = suppressProgress(ctx)
    ? undefined
    : (line: string) => {
        if (process.stderr.isTTY) process.stderr.write(c.dim(`  ${line}\n`));
      };

  // Light path (default) or rich path (--fresh/--sign/--policy/--tier), both fail-closed.
  const verdict = await resolveGateVerdict(ctx, onStderr);
  const exitCode = exitCodeForTier(verdict.verdict);
  if (ctx.json) return { json: { ...verdict, ok: verdict.verdict === "allow" }, exitCode };
  return { text: renderVerdictCard(verdict), exitCode };
}
