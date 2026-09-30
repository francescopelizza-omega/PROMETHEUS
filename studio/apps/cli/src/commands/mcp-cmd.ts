/**
 * commands/mcp-cmd.ts — `prometheus mcp [list|add|remove|test]` (CLI-036).
 *
 * Manage MCP connectors from the terminal, at parity with the desktop Extensions panel:
 * list configured servers, add a nemesis-GATED stdio server, remove one (typed confirm),
 * and test one via a real `initialize → tools/list` handshake. Configs persist in the
 * CLI config dir (mcp-servers.json). Fail-closed: a gate BLOCK refuses the add; an
 * option-shaped `--cmd` is refused; `test` is bounded by the transport's request timeout.
 * All seams (manager / gate / transport / confirm) are injectable for tests.
 */
import { mcpHost } from "@prometheus/core";
import { appendMcpAudit, createMcpTransportFactory } from "@prometheus/core/mcp-node";
import { type EngineConfig, createMcpGateRunner } from "@prometheus/engine-bridge";

import type { CliContext, CommandOutcome } from "../context.js";
import { prometheusHome } from "../home.js";
import { CliMcpConfigStore, mcpStorePath } from "../mcp-store.js";
import { c, heading, table } from "../render.js";
import { createCliSecretsStore } from "../secrets-backend.js";

/** The keychain service under which `--auth-secret <ref>` bearer tokens are stored (never in config). */
// one canonical service name, shared with the desktop — see core's mcpHost.
const MCP_AUTH_SERVICE = mcpHost.MCP_AUTH_SERVICE;

type McpHostManager = mcpHost.McpHostManager;

/** The real nemesis gate for the CLI (wraps engine-bridge `gate` — fail-closed to error). */
function createCliMcpGate(config: EngineConfig = {}): mcpHost.NemesisGate {
  // The runner lives in engine-bridge: this file, its sibling in session/, and the desktop each
  // had their own copy, and all three fed the target to nemesis's FILE scanner — so `npx` scored
  // `error`/risk 100, every server was persisted `health:"blocked"`, and no MCP connector could
  // be added at all. `createMcpGateRunner` judges a launch command as command TEXT instead.
  return createMcpGateRunner(config) as mcpHost.NemesisGate;
}

export interface McpCmdDeps {
  manager: McpHostManager;
  confirm: (prompt: string) => Promise<boolean>;
  /**
   * The gate a `--dry-run` preview consults — the SAME one `manager` would use for a real add.
   *
   * Injected rather than freshly constructed, so a preview and the real thing can never disagree
   * about a verdict. Building a new real gate here made the preview ignore an injected one
   * entirely, which is the "two copies of one decision" pattern this repo keeps being bitten by.
   */
  gate?: mcpHost.NemesisGate;
}

function defaultMcpDeps(home: string = prometheusHome()): McpCmdDeps {
  // The http transport resolves `--auth-secret <ref>` bearer tokens through the OS keychain at
  // connect time; the raw token never lands in mcp-servers.json (only the ref name does).
  const secrets = createCliSecretsStore();
  const gate = createCliMcpGate();
  const manager = new mcpHost.McpHostManager({
    store: new CliMcpConfigStore(mcpStorePath(home)),
    gate,
    transport: createMcpTransportFactory({
      resolveAuth: (ref: string) => secrets.get(MCP_AUTH_SERVICE, ref),
    }),
    onToolDrift: (info) => appendMcpAudit(home, { event: "tool-drift", ...info }),
  });
  return { manager, gate, confirm: async () => false }; // non-interactive default = deny (never-force)
}

function flagStr(ctx: CliContext, key: string): string | undefined {
  const v = ctx.args.flags[key];
  return typeof v === "string" ? v : undefined;
}

function transportLabel(cfg: mcpHost.McpServerConfig): string {
  const t = cfg.transport;
  return t.kind === "stdio"
    ? `stdio: ${t.command} ${t.args.join(" ")}`.trim()
    : `http: ${(t as { url?: string }).url ?? ""}`;
}

export async function runMcpCommand(
  ctx: CliContext,
  deps: McpCmdDeps = defaultMcpDeps(),
): Promise<CommandOutcome> {
  // `unmatchedSub` (parse.ts) distinguishes "a second word WAS typed but didn't match
  // list/add/remove/test" from "nothing was typed" — without it a typo silently fell
  // through to the "list" branch below instead of being reported.
  const sub = ctx.args.unmatchedSub ?? ctx.args.command[1] ?? "list";
  const { manager } = deps;

  if (sub !== "list" && sub !== "add" && sub !== "remove" && sub !== "test") {
    return {
      text: c.red(
        `prometheus mcp ${sub}: unknown mcp verb.\n  ${c.dim("try:")} list · add · remove · test`,
      ),
      json: { ok: false, error: "unknown-verb", command: `mcp ${sub}` },
      exitCode: 1,
    };
  }

  if (sub === "add") {
    const name = ctx.args.positionals[0];
    const url = flagStr(ctx, "url");
    const cmd = flagStr(ctx, "cmd");
    if (!name || (!cmd && !url)) {
      return usage(
        "mcp add",
        '<name> (--cmd <bin> [--args "a b"] | --url <https-url> [--auth-secret <ref>] [--timeout-ms N])',
      );
    }
    let cfg: mcpHost.McpServerConfig;
    if (url) {
      // remote (streamable-HTTP) server (CLI-037). Guard option-injection, then run the SAME
      // pure SSRF/scheme/header gate the desktop uses BEFORE storing — fail-closed.
      if (url.startsWith("-")) {
        return {
          text: c.red(`mcp add: refusing option-shaped --url: ${url}`),
          json: { ok: false, error: "bad-url" },
          exitCode: 2,
        };
      }
      const authSecretRef = flagStr(ctx, "auth-secret");
      if (authSecretRef?.startsWith("-")) {
        return {
          text: c.red(`mcp add: refusing option-shaped --auth-secret: ${authSecretRef}`),
          json: { ok: false, error: "bad-auth-secret" },
          exitCode: 2,
        };
      }
      const timeoutStr = flagStr(ctx, "timeout-ms");
      const timeoutMs = timeoutStr === undefined ? undefined : Number(timeoutStr);
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        return {
          text: c.red(`mcp add: --timeout-ms must be a positive number, got: ${timeoutStr}`),
          json: { ok: false, error: "bad-timeout" },
          exitCode: 2,
        };
      }
      const httpTransport: mcpHost.McpTransport = {
        kind: "http",
        url,
        ...(authSecretRef ? { authSecretRef } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
      const v = mcpHost.validateRemoteTransport({ kind: "http", url });
      if (!v.ok) {
        return {
          text: c.red(`mcp add: refusing url — ${v.error}`),
          json: { ok: false, error: "bad-url", detail: v.error },
          exitCode: 2,
        };
      }
      cfg = {
        id: name,
        label: name,
        transport: httpTransport,
        enabled: true,
        scope: "global",
        autoApprove: [],
        source: "manual",
        health: "unknown",
      };
    } else {
      const command = cmd as string;
      if (command.startsWith("-")) {
        return {
          text: c.red(`mcp add: refusing option-shaped --cmd: ${command}`),
          json: { ok: false, error: "bad-cmd" },
          exitCode: 2,
        };
      }
      // --args is space-separated simple tokens (never shell-split — a value starting with
      // '-' is a legit flag FOR THE SERVER, so it is allowed here; only --cmd is guarded).
      const args = (flagStr(ctx, "args") ?? "").split(/\s+/).filter(Boolean);
      cfg = {
        id: name,
        label: name,
        transport: { kind: "stdio", command, args },
        enabled: true,
        scope: "global",
        autoApprove: [],
        source: "manual",
        health: "unknown",
      };
    }
    /**
     * `--dry-run` PREVIEWS. It used to be ignored entirely.
     *
     * `dry-run` is a declared global boolean (`parse.ts`), forwarded to the engine for every
     * registry-routed verb, and shown in `--help` — so a user who types it on a prom-native verb
     * reasonably expects a preview. `mcp add --dry-run` instead ran the full add: gated, wrote
     * `mcp-servers.json`, and the server appeared in `mcp list`. Measured end to end.
     *
     * The GATE still runs, because "what would happen" includes "would nemesis allow it" — that
     * is the useful half of a preview here. Nothing is persisted.
     */
    if (ctx.args.dryRun) {
      const spec = mcpHost.gateTargetSpec(cfg);
      const verdict = await (deps.gate ?? createCliMcpGate())(spec.target, spec.kind);
      const blocked = mcpHost.verdictBlocks(verdict);
      return {
        text: blocked
          ? c.red(`mcp add (preview): "${name}" WOULD BE BLOCKED by nemesis (${verdict.verdict}).`)
          : `${c.dim("preview:")} would add MCP server ${c.bold(name)} ${c.dim(`(${transportLabel(cfg)})`)} — nothing written`,
        json: { ok: !blocked, preview: true, id: name, gate: verdict },
        exitCode: blocked ? 2 : 0,
      };
    }
    const stored = await manager.addServer(cfg); // nemesis-gated inside (http → URL is gated)
    if (stored.health === "blocked") {
      /**
       * "not added" was FALSE. `addServer` deliberately PERSISTS a blocked server —
       * `enabled:false, health:"blocked"` — and that record is load-bearing: `connect()` refuses
       * on it and the re-enable path checks it, so the row is what makes the block stick. The
       * control holds; only the report was wrong, and it was wrong in the direction that matters,
       * telling the user nothing had been written while `mcp list` showed the server and
       * `mcp-servers.json` contained it.
       */
      return {
        text: c.red(
          `mcp add: "${name}" was BLOCKED by nemesis (${stored.gate?.verdict}).\n  recorded as blocked and DISABLED — it cannot be started. Remove it with \`prometheus mcp remove ${name} --yes\`.`,
        ),
        json: {
          ok: false,
          error: "gate-blocked",
          id: name,
          stored: true,
          enabled: false,
          health: "blocked",
          gate: stored.gate,
        },
        exitCode: 2,
      };
    }
    return {
      text: `${c.green("✓")} added MCP server ${c.bold(name)} ${c.dim(`(${transportLabel(stored)})`)}`,
      json: { ok: true, id: name, gate: stored.gate ?? null },
      exitCode: 0,
    };
  }

  if (sub === "remove") {
    const name = ctx.args.positionals[0];
    if (!name) return usage("mcp remove", "<name> [--yes]");
    if (!manager.get(name)) {
      return {
        text: c.red(`mcp remove: no such server "${name}"`),
        json: { ok: false, error: "not-found", id: name },
        exitCode: 2,
      };
    }
    const confirmed = ctx.args.yes === true || (await deps.confirm(`remove MCP server "${name}"?`));
    if (!confirmed) {
      return {
        text: `to remove "${name}", re-run with ${c.bold("--yes")}`,
        json: { ok: false, error: "confirm-required", id: name },
        exitCode: 2,
      };
    }
    // `--dry-run` previews here too — it used to remove the server outright. Measured.
    if (ctx.args.dryRun) {
      return {
        text: `${c.dim("preview:")} would remove ${c.bold(name)} — nothing changed`,
        json: { ok: true, preview: true, id: name },
        exitCode: 0,
      };
    }
    await manager.removeServer(name);
    return { text: `${c.green("✓")} removed ${name}`, json: { ok: true, id: name }, exitCode: 0 };
  }

  if (sub === "test") {
    const name = ctx.args.positionals[0];
    if (!name) return usage("mcp test", "<name>");
    if (!manager.get(name)) {
      return {
        text: c.red(`mcp test: no such server "${name}"`),
        json: { ok: false, error: "not-found", id: name },
        exitCode: 2,
      };
    }
    try {
      const updated = await manager.connect(name); // spawn → initialize → tools/list
      const tools = updated.capabilities?.tools ?? [];
      await manager.disconnect(name);
      if (ctx.json)
        return { json: { ok: true, id: name, tools: tools.map((t) => t.name) }, exitCode: 0 };
      const names = tools.map((t) => t.name).join(", ");
      return {
        text: `${c.green("✓")} ${name}: handshake ok — ${tools.length} tool${tools.length === 1 ? "" : "s"}${names ? ` (${c.dim(names)})` : ""}`,
        exitCode: 0,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        text: c.red(`mcp test "${name}" failed: ${msg}`),
        json: { ok: false, error: "handshake-failed", id: name, detail: msg },
        exitCode: 2,
      };
    }
  }

  // default: list
  const servers = manager.list();
  if (ctx.json) return { json: { ok: true, servers }, exitCode: 0 };
  if (servers.length === 0)
    return {
      text: c.dim("no MCP servers configured — add one: prometheus mcp add <name> --cmd <bin>"),
      exitCode: 0,
    };
  const rows = servers.map((s) => [
    s.label,
    transportLabel(s),
    healthCell(s.health),
    String(s.capabilities?.tools.length ?? "—"),
  ]);
  const lines = [heading(`MCP servers  ${c.dim(`(${servers.length})`)}`), ""];
  lines.push(
    table(
      [{ header: "NAME" }, { header: "TRANSPORT" }, { header: "STATUS" }, { header: "TOOLS" }],
      rows,
    ),
  );
  return { text: lines.join("\n"), exitCode: 0 };
}

function healthCell(h: mcpHost.McpServerHealth): string {
  switch (h) {
    case "ready":
      return c.green(h);
    case "blocked":
    case "error":
      return c.red(h);
    case "starting":
      return c.yellow(h);
    default:
      return c.dim(h);
  }
}

/** A LOCAL twin of `sidecar-cmd.ts`'s `usageError` — kept in step with it by the CLI-084 guard. */
function usage(command: string, usageStr: string): CommandOutcome {
  return {
    text: `prometheus ${command}: missing argument.\n  ${c.dim("usage:")} prometheus ${command} ${usageStr}`,
    json: { ok: false, error: "missing-argument", command },
    // Bad args are class 1; 2 is the fail-closed security-block signal. This copy still said 2
    // after `usageError` moved — the exact drift `prom.test.ts`'s source-level guard now catches.
    exitCode: 1,
  };
}
