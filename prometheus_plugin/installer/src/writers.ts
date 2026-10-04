// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * writers.ts — merge-safe config writers.
 *
 * Every writer reads the existing config (or starts empty), splices ONLY the
 * `prometheus` server entry, and leaves every other server/setting untouched.
 * Writes are atomic (temp file + rename). Idempotent: re-running replaces just
 * the prometheus entry.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import TOML from "@iarna/toml";
import { parseDocument, YAMLSeq } from "yaml";
import { AgentTarget, serverEntry, Launch } from "./agents.js";

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function atomicWrite(p: string, content: string): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + `.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);
}

export interface WriteResult {
  agent: string;
  path: string;
  action: "written" | "updated" | "skipped";
  note: string;
}

/**
 * Build + merge the prometheus entry into the target's config, honoring its
 * format. Returns what was done. When dryRun, computes the action but writes
 * nothing.
 */
export function applyAgent(t: AgentTarget, pyPath: string, dryRun: boolean, launch: Launch): WriteResult {
  const server = serverEntry(pyPath, launch);
  const existed = existsSync(t.configPath);
  let merged: string;
  let had = false;

  switch (t.format) {
    case "json-mcpServers": {
      const obj = parseJson(readText(t.configPath));
      obj.mcpServers ??= {};
      had = !!obj.mcpServers.prometheus;
      obj.mcpServers.prometheus = { type: "stdio", ...server };
      merged = JSON.stringify(obj, null, 2) + "\n";
      break;
    }
    case "json-cline": {
      const obj = parseJson(readText(t.configPath));
      obj.mcpServers ??= {};
      had = !!obj.mcpServers.prometheus;
      obj.mcpServers.prometheus = { ...server, disabled: false, autoApprove: [] };
      merged = JSON.stringify(obj, null, 2) + "\n";
      break;
    }
    case "json-contextServers": {
      const obj = parseJson(readText(t.configPath));
      obj.context_servers ??= {};
      had = !!obj.context_servers.prometheus;
      obj.context_servers.prometheus = { source: "custom", ...server };
      merged = JSON.stringify(obj, null, 2) + "\n";
      break;
    }
    case "toml-mcpServers": {
      // text-splice so user COMMENTS and unrelated tables are preserved (a full
      // @iarna/toml reparse+stringify would drop every comment). Replace just the
      // [mcp_servers.prometheus] table — with any [mcp_servers.prometheus.*] sub-table, which is
      // how `codex mcp add` writes env — if present, else append it.
      //
      // Emitted key by key with TOML.stringify.value, NOT "[mcp_servers.prometheus]\n" +
      // TOML.stringify({ ..., env }): @iarna/toml heads a nested object with its key relative to
      // the ROOT, so env came out as a TOP-LEVEL [env] table. PROMETHEUS_PY never reached the
      // server, and since the old replace stopped at the next "\n[", every re-run (a repair
      // included) appended a second [env] — a duplicate table, invalid TOML, and Codex rejects its
      // whole config.toml (found in a real ~/.codex/config.toml, 2026-10-03).
      const raw = readText(t.configPath);
      const v = TOML.stringify.value;
      const block =
        [
          "[mcp_servers.prometheus]",
          `command = ${v(server.command)}`,
          `args = ${v(server.args)}`,
          ...(Object.keys(server.env).length > 0 ? [`env = ${v(server.env)}`] : []),
          "startup_timeout_sec = 30",
          "tool_timeout_sec = 600",
        ].join("\n") + "\n";
      const sectionRx =
        /(^|\n)\[mcp_servers\.prometheus\][\s\S]*?(?=\n\[(?!mcp_servers\.prometheus[.\]])|\n*$)/;
      // The orphan an earlier version of this writer left behind: a top-level [env] holding only
      // PROMETHEUS_PY. Dropped so the file parses again; an [env] with anything else is left alone.
      const orphanRx = /(^|\n)\[env\]\nPROMETHEUS_PY = "[^"\n]*"\n?(?=\n|\[|$)/g;
      const cleaned = raw.replace(orphanRx, "$1");
      if (sectionRx.test(cleaned)) {
        had = true;
        merged = cleaned.replace(sectionRx, (m) => (m.startsWith("\n") ? "\n" : "") + block.trimEnd());
        if (!merged.endsWith("\n")) merged += "\n";
      } else {
        had = false;
        merged = (cleaned.trimEnd() ? cleaned.trimEnd() + "\n\n" : "") + block;
      }
      break;
    }
    case "yaml-list": {
      // parseDocument preserves comments + formatting of untouched nodes. We
      // replace only the prometheus entry inside the mcpServers list.
      const doc = readText(t.configPath) ? parseDocument(readText(t.configPath)) : parseDocument("{}");
      let seq = doc.get("mcpServers") as YAMLSeq | undefined;
      if (!seq || !(seq instanceof YAMLSeq)) {
        seq = new YAMLSeq();
        doc.set("mcpServers", seq);
      }
      const entry = {
        name: "prometheus",
        type: "stdio",
        command: server.command,
        args: server.args,
        env: server.env,
      };
      const idx = seq.items.findIndex((it: any) => it?.get?.("name") === "prometheus");
      if (idx >= 0) {
        had = true;
        seq.items[idx] = doc.createNode(entry);
      } else {
        seq.add(doc.createNode(entry));
      }
      merged = doc.toString();
      break;
    }
    case "gemini-extension": {
      // own directory; whole-file write of the extension manifest + GEMINI.md
      had = existed;
      const manifest = {
        name: "prometheus",
        version: "1.0.0",
        description: "Prometheus MCP tools for Gemini CLI",
        contextFileName: "GEMINI.md",
        mcpServers: {
          prometheus: { ...server, cwd: "${extensionPath}", timeout: 600000 },
        },
      };
      merged = JSON.stringify(manifest, null, 2) + "\n";
      if (!dryRun) {
        const ctx = join(dirname(t.configPath), "GEMINI.md");
        atomicWrite(
          ctx,
          "# Prometheus (via MCP)\n\nThis extension exposes the Prometheus AI-agent " +
            "plugin scanner/installer as MCP tools (prefix `prometheus_`). Always " +
            "preview `prometheus_install` with `dryRun:true` first.\n",
        );
      }
      break;
    }
    default:
      throw new Error(`unknown format: ${(t as AgentTarget).format}`);
  }

  const action: WriteResult["action"] = had ? "updated" : "written";
  if (!dryRun) atomicWrite(t.configPath, merged);
  return { agent: t.id, path: t.configPath, action: dryRun ? "skipped" : action, note: t.note };
}

function parseJson(text: string): any {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("existing config is not valid JSON — refusing to overwrite");
  }
}
