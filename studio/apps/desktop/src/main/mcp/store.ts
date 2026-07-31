/**
 * main/mcp/store.ts — the disk-backed MCP ConfigStore (file 09 §2.1/§6).
 *
 * The core `McpHostManager` persists connector configs through an injected
 * `ConfigStore` (pure interface). Core ships an in-memory one for tests; the desktop
 * provides THIS disk-backed impl so connectors the user adds / enables / imports
 * actually SURVIVE a restart — the missing piece that made the old Extensions panel a
 * throwaway static list. The `ConfigStore` interface is synchronous, so we load once
 * into a Map at construction and write the whole (small) file through on every
 * mutation. Fail-soft: a corrupt/absent file starts empty; a read-only fs degrades to
 * in-memory for the session (never throws).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { mcpHost } from "@prometheus/core";

type McpServerConfig = mcpHost.McpServerConfig;

export class DiskConfigStore implements mcpHost.ConfigStore {
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
      /* corrupt or unreadable → start empty (never crash the app over a config file) */
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ servers: [...this.map.values()] }, null, 2));
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
