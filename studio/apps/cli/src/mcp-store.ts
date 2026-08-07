/**
 * mcp-store.ts — the CLI's disk-backed MCP ConfigStore (CLI-036).
 *
 * Mirrors the desktop DiskConfigStore so a connector added from `prometheus mcp add` SURVIVES a
 * restart and is the SAME `mcp-servers.json` shape the desktop Extensions panel manages.
 * Load once into a Map; write the whole (small) file through on every mutation via an
 * ATOMIC temp+rename so a crash mid-write can't corrupt the file. Fail-soft: a corrupt/
 * absent file starts empty; a read-only fs degrades to in-memory for the session.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { mcpHost } from "@prometheus/core";

import { prometheusHome } from "./home.js";

type McpServerConfig = mcpHost.McpServerConfig;

/** The connector config file path (under the config dir, next to settings.json). */
export function mcpStorePath(home: string = prometheusHome()): string {
  return join(home, "config", "mcp-servers.json");
}

export class CliMcpConfigStore implements mcpHost.ConfigStore {
  private readonly path: string;
  private readonly map = new Map<string, McpServerConfig>();

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { servers?: McpServerConfig[] };
      for (const c of raw.servers ?? []) {
        if (c && typeof c.id === "string") this.map.set(c.id, c);
      }
    } catch {
      /* corrupt or unreadable → start empty (never crash over a config file) */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ servers: [...this.map.values()] }, null, 2));
      renameSync(tmp, this.path); // atomic replace
    } catch {
      /* read-only fs / quota → keep the in-memory copy for this session only */
    }
  }

  list(): McpServerConfig[] {
    return [...this.map.values()];
  }
  get(id: string): McpServerConfig | undefined {
    return this.map.get(id);
  }
  upsert(cfg: McpServerConfig): void {
    this.map.set(cfg.id, cfg);
    this.persist();
  }
  remove(id: string): void {
    this.map.delete(id);
    this.persist();
  }
}
