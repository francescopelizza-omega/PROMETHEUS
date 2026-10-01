// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
  /** Not readonly: `upsert`/`remove` adopt a freshly re-read disk view before writing. */
  private map = new Map<string, McpServerConfig>();

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

  /**
   * The servers as they are ON DISK right now, or null when the file is unreadable/corrupt.
   *
   * `load()` runs once, in the constructor, and `persist()` rewrites the whole file from the
   * in-memory map — so a long-lived process wrote a snapshot taken at STARTUP. A chat session
   * open in one terminal and `prometheus mcp add beta` run in another ended with `beta` silently
   * deleted the moment the session's own `disconnect()` upserted a health field on an unrelated
   * server. Re-reading immediately before a write turns a whole-file overwrite into the delta it
   * was always meant to be.
   */
  private fromDisk(): Map<string, McpServerConfig> | null {
    try {
      if (!existsSync(this.path)) return new Map();
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { servers?: McpServerConfig[] };
      const fresh = new Map<string, McpServerConfig>();
      for (const c of raw.servers ?? []) {
        if (c && typeof c.id === "string") fresh.set(c.id, c);
      }
      return fresh;
    } catch {
      // Corrupt/unreadable: fall back to the in-memory view rather than an EMPTY one, so a
      // config we cannot parse is never silently replaced by this one process's slice of it.
      return null;
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
    const merged = this.fromDisk() ?? this.map;
    merged.set(cfg.id, cfg);
    this.map = merged;
    this.persist();
  }
  remove(id: string): void {
    const merged = this.fromDisk() ?? this.map;
    merged.delete(id);
    this.map = merged;
    this.persist();
  }
}
