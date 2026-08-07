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
import { createMcpTransportFactory } from "@prometheus/core/mcp-node";
import { type EngineConfig, type VerdictTier, gate as engineGate } from "@prometheus/engine-bridge";

import type { CliContext, CommandOutcome } from "../context.js";
import { prometheusHome } from "../home.js";
import { CliMcpConfigStore, mcpStorePath } from "../mcp-store.js";
import { c, heading, table } from "../render.js";
import { createCliSecretsStore } from "../secrets-backend.js";

/** The keychain service under which `--auth-secret <ref>` bearer tokens are stored (never in config). */
const MCP_AUTH_SERVICE = "prometheus-mcp-auth";

type McpHostManager = mcpHost.McpHostManager;

/** The real nemesis gate for the CLI (wraps engine-bridge `gate` — fail-closed to error). */
function createCliMcpGate(config: EngineConfig = {}): mcpHost.NemesisGate {
  return async (target: string): Promise<mcpHost.HostGateVerdict> => {
    try {
      const v = await engineGate(target, {}, config);
      return { verdict: v.verdict, riskScore: v.risk_score, target, findings: v.findings.length };
    } catch {
      return { verdict: "error" as VerdictTier, target, findings: 0 };
    }
  };
}

export interface McpCmdDeps {
  manager: McpHostManager;
  confirm: (prompt: string) => Promise<boolean>;
}

function defaultMcpDeps(home: string = prometheusHome()): McpCmdDeps {
  // The http transport resolves `--auth-secret <ref>` bearer tokens through the OS keychain at
  // connect time; the raw token never lands in mcp-servers.json (only the ref name does).
  const secrets = createCliSecretsStore();
  const manager = new mcpHost.McpHostManager({
    store: new CliMcpConfigStore(mcpStorePath(home)),
    gate: createCliMcpGate(),
    transport: createMcpTransportFactory({
      resolveAuth: (ref: string) => secrets.get(MCP_AUTH_SERVICE, ref),
    }),
  });
  return { manager, confirm: async () => false }; // non-interactive default = deny (never-force)
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
  const sub = ctx.args.command[1] ?? "list";
  const { manager } = deps;

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
    const stored = await manager.addServer(cfg); // nemesis-gated inside (http → URL is gated)
    if (stored.health === "blocked") {
      return {
        text: c.red(
          `mcp add: "${name}" was BLOCKED by nemesis (${stored.gate?.verdict}) — not added.`,
        ),
        json: { ok: false, error: "gate-blocked", id: name, gate: stored.gate },
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

function usage(command: string, usageStr: string): CommandOutcome {
  return {
    text: `prometheus ${command}: missing argument.\n  ${c.dim("usage:")} prometheus ${command} ${usageStr}`,
    json: { ok: false, error: "missing-argument", command },
    exitCode: 2,
  };
}
