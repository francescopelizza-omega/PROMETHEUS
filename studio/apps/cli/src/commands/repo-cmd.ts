/**
 * commands/repo-cmd.ts — the FULL `prometheus repo …` surface over the repo.py sidecar
 * (C7 / file 06 §3), at parity with the GUI Repos panel. This is the ONLY
 * arbitrary-URL clone path: every fetch is STAGED with safe git flags then run
 * through the REAL nemesis gate (stage → gate → promote | quarantine). A BLOCK
 * rides through as `ok:false, blocked:true` — JS never decides "safe" (C5).
 * Mutations PREVIEW first and EXECUTE on `--yes`; repo.py has no `--confirm`
 * toggle, so executing simply runs the gated verb (confirm:false).
 *
 *   repo add <url> [--branch B] [--pin SHA]    clone (gated)         [mutate/gated]
 *   repo list                                  every managed repo           [read]
 *   repo status [id]                           on-disk status (alias of list)[read]
 *   repo rescan <id> [--gate-fresh]            re-gate the live tree         [read]
 *   repo update <id>                           re-fetch HEAD → re-gate[mutate/gated]
 *   repo pin <id> <sha>                        detached pin → re-gate [mutate/gated]
 *   repo branch <id> <branch>                  switch branch → re-gate[mutate/gated]
 *   repo remove <id>                           drop the clone dir + index   [mutate]
 */
import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, kv, table } from "../render.js";
import {
  type SidecarDeps,
  defaultSidecarDeps,
  flagSet,
  flagStr,
  runMutation,
  runRead,
  usageError,
} from "./sidecar-cmd.js";

const SCRIPT = "repo.py" as const;

function sub(ctx: CliContext): string {
  // see secure-cmd.ts's identical fix: `unmatchedSub` (parse.ts) distinguishes "a second word
  // was typed but didn't match" from "no second word at all" — without it, a typo like
  // `/repo removee myid` silently fell through to "list", discarding "removee" and "myid" both,
  // with the switch's own "unknown repo verb" branch below never reachable from real input.
  return ctx.args.unmatchedSub ?? ctx.args.command[1] ?? "list";
}

export async function runRepoCommand(
  ctx: CliContext,
  deps: SidecarDeps = defaultSidecarDeps,
): Promise<CommandOutcome> {
  const verb = sub(ctx);
  const pos = ctx.args.positionals;

  switch (verb) {
    case "list":
    case "status":
      return runRead(ctx, {
        command: "repo list",
        script: SCRIPT,
        argv: ["list"],
        deps,
        render: (e) => renderRepos(e),
      });

    case "rescan": {
      const id = pos[0];
      if (!id) return usageError("repo rescan", "<id> [--gate-fresh]");
      const argv = ["rescan", "--id", id];
      if (flagSet(ctx, "gate-fresh")) argv.push("--gate-fresh");
      return runRead(ctx, {
        command: "repo rescan",
        script: SCRIPT,
        argv,
        deps,
        render: (e) => renderRescan(id, e),
      });
    }

    case "add":
    case "clone": {
      const url = pos[0];
      if (!url) return usageError("repo add", "<url> [--branch B] [--pin SHA]");
      const base = ["clone", "--url", url];
      const branch = flagStr(ctx, "branch");
      if (branch) base.push("--branch", branch);
      const pin = flagStr(ctx, "pin");
      if (pin) base.push("--pin", pin);
      const staged = flagStr(ctx, "staged");
      if (staged) base.push("--staged", staged);
      return runMutation(ctx, {
        command: "repo add",
        script: SCRIPT,
        base,
        note: `clone ${url} → stage (safe flags) → nemesis gate → promote | quarantine`,
        deps,
        confirm: false,
      });
    }

    case "update": {
      const id = pos[0];
      if (!id) return usageError("repo update", "<id>");
      return runMutation(ctx, {
        command: "repo update",
        script: SCRIPT,
        base: ["update", "--id", id],
        note: `re-fetch HEAD of '${id}' → re-gate`,
        deps,
        confirm: false,
      });
    }

    case "pin": {
      const [id, sha] = pos;
      if (!id || !sha) return usageError("repo pin", "<id> <sha>");
      return runMutation(ctx, {
        command: "repo pin",
        script: SCRIPT,
        base: ["pin", "--id", id, "--sha", sha],
        note: `pin '${id}' to ${sha} → re-gate the pinned tree`,
        deps,
        confirm: false,
      });
    }

    case "branch": {
      const [id, branch] = pos;
      if (!id || !branch) return usageError("repo branch", "<id> <branch>");
      return runMutation(ctx, {
        command: "repo branch",
        script: SCRIPT,
        base: ["branch", "--id", id, "--branch", branch],
        note: `switch '${id}' to ${branch} → re-gate (clears pin)`,
        deps,
        confirm: false,
      });
    }

    case "remove": {
      const id = pos[0];
      if (!id) return usageError("repo remove", "<id>");
      return runMutation(ctx, {
        command: "repo remove",
        script: SCRIPT,
        base: ["remove", "--id", id],
        note: `drop the clone dir + index entry for '${id}'`,
        deps,
        confirm: false,
      });
    }

    default:
      return {
        text:
          `prometheus repo ${verb}: unknown repo verb.\n` +
          `  ${c.dim("try:")} add · list · status · rescan · update · pin · branch · remove · vault`,
        json: { ok: false, error: "unknown-verb", command: `repo ${verb}` },
        exitCode: 1,
      };
  }
}

/* ----------------------------- read renderers ----------------------------- */

interface RepoRow {
  id?: string;
  url?: string;
  branch?: string;
  status?: string;
  pinned?: string | null;
  verdict?: string;
}

function statusBadge(s: string | undefined): string {
  switch (s) {
    case "promoted":
    case "clean":
    case "ok":
      return c.green(s);
    case "quarantined":
    case "blocked":
      return c.red(s);
    default:
      return c.dim(s ?? "—");
  }
}

function renderRepos(e: Record<string, unknown>): CommandOutcome {
  const repos = Array.isArray(e.repos) ? (e.repos as RepoRow[]) : [];
  const lines = [heading(`Repos  ${c.dim(`(${repos.length})`)}`), ""];
  if (repos.length === 0) {
    lines.push(c.dim("No managed repos. Add one with `prometheus repo add <url> --yes`."));
    return { text: lines.join("\n"), exitCode: 0 };
  }
  const rows = repos.map((r) => [
    r.id ?? "—",
    c.dim(r.branch ?? "—"),
    statusBadge(r.status),
    c.dim(r.pinned ? `@${r.pinned}` : "—"),
    c.dim(r.url ?? ""),
  ]);
  lines.push(
    table(
      [
        { header: "ID" },
        { header: "BRANCH" },
        { header: "STATUS" },
        { header: "PIN" },
        { header: "URL" },
      ],
      rows,
    ),
  );
  return { text: lines.join("\n"), exitCode: 0 };
}

export function renderRescan(id: string, e: Record<string, unknown>): CommandOutcome {
  const verdict = typeof e.verdict === "string" ? e.verdict : "unknown";
  const badge =
    verdict === "allow"
      ? c.green(verdict)
      : verdict === "warn"
        ? c.yellow(verdict)
        : c.red(verdict);
  const lines = [heading(`Rescan  ${c.dim(id)}`), "", kv("verdict", badge)];
  if (typeof e.risk_score === "number") lines.push(kv("risk", String(e.risk_score)));
  const findings = Array.isArray(e.findings) ? e.findings : [];
  lines.push(kv("findings", String(findings.length)));
  // mirror the nemesis tier→exit contract so a block/deny rescan is DETECTABLE in CI (`$? -eq 20`),
  // not a silent exit 0. warn=10 · block/deny=20 · error=2 · allow/anything-else=0 (a read command
  // must not fail on an unrecognized verdict string).
  const exitCode =
    verdict === "warn"
      ? 10
      : verdict === "block" || verdict === "deny"
        ? 20
        : verdict === "error"
          ? 2
          : 0;
  /**
   * The `--json` channel must mirror the tier too, not just the exit code.
   *
   * This returned no `json`, so the caller fell back to the engine's raw envelope — which
   * `_envelope.emit()` stamps `"ok": true` for any scan that COMPLETED. So a repo whose live tree
   * now scans BLOCK came back as `{"ok": true}` while the process exited 20, and a CI script
   * branching on `.ok` (the documented envelope contract) treated it as clean. Only a script that
   * happened to read `$?` or `.verdict` caught it.
   *
   * `ok = allow` is the same rule `prometheus gate` uses, so the two gate-bearing surfaces agree
   * about what `ok` means: it answers "is this safe to use", not "did the scan run".
   */
  return {
    text: lines.join("\n"),
    json: { ...e, ok: verdict === "allow" },
    exitCode,
  };
}
