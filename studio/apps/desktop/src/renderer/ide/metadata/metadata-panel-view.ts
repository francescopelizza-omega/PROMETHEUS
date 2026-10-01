// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * metadata-panel-view.ts — PURE view-model for the Metadata panel (file 0C, privacy).
 *
 * Turns a `MetadataInspectResult` (read over window.prometheus.metadata, C5 sandbox —
 * no core/engine-bridge import) into grouped, formatted, privacy-flagged rows the panel
 * renders, plus byte/epoch formatting + the sensitive-field heuristic that highlights
 * exactly the metadata a user most wants to scrub (GPS, author, device, …). node:test-
 * tested, no DOM. Type-only import of the contract result shape.
 */
import { isSensitiveMetadataKey } from "@prometheus/core/metadata";

import type { MetadataInspectResult } from "../../../shared/ipc-contract.js";

export type MetaGroup = "File" | "Extended attributes" | "Content tags";

/** One displayed metadata row. */
export interface MetadataRow {
  group: MetaGroup;
  key: string;
  value: string;
  /** true ⇒ this field commonly leaks personal/location/device info (privacy emphasis). */
  sensitive: boolean;
  /** the field is editable (content tags via exiftool); fs/xattr rows are not. */
  editable: boolean;
}

/** Format a byte count human-readably. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Format epoch seconds as an ISO-ish UTC string (deterministic, no locale). */
export function formatEpoch(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * Whether a metadata key commonly leaks personal / location / device info.
 *
 * The list lives in core so this panel and the CLI's `metadata inspect` cannot disagree about
 * what counts as sensitive — they are two views of the same privacy decision. Re-exported here
 * because this module's own consumers (and its tests) already import it by this name.
 */
export const isSensitiveKey = isSensitiveMetadataKey;

/** Build the grouped, formatted, flagged rows for the table. */
export function buildMetadataRows(inspect: MetadataInspectResult): MetadataRow[] {
  const rows: MetadataRow[] = [];
  const fs = inspect.fs;
  if (fs) {
    rows.push({
      group: "File",
      key: "Path",
      value: inspect.file ?? "",
      sensitive: false,
      editable: false,
    });
    rows.push({
      group: "File",
      key: "Type",
      value: inspect.mime ?? "",
      sensitive: false,
      editable: false,
    });
    rows.push({
      group: "File",
      key: "Size",
      value: formatBytes(fs.size),
      sensitive: false,
      editable: false,
    });
    // timestamps are normalizable (via timestomp) but not a content "leak" → not flagged.
    rows.push({
      group: "File",
      key: "Modified",
      value: formatEpoch(fs.mtime),
      sensitive: false,
      editable: false,
    });
    rows.push({
      group: "File",
      key: "Accessed",
      value: formatEpoch(fs.atime),
      sensitive: false,
      editable: false,
    });
    if (fs.birthtime !== undefined) {
      rows.push({
        group: "File",
        key: "Created",
        value: formatEpoch(fs.birthtime),
        sensitive: false,
        editable: false,
      });
    }
    rows.push({
      group: "File",
      key: "Permissions",
      value: fs.mode,
      sensitive: false,
      editable: false,
    });
  }
  for (const name of inspect.xattrs ?? []) {
    rows.push({
      group: "Extended attributes",
      key: name,
      value: "(present)",
      sensitive: isSensitiveKey(name),
      editable: false,
    });
  }
  for (const [key, value] of Object.entries(inspect.tags ?? {})) {
    rows.push({
      group: "Content tags",
      key,
      value: String(value),
      sensitive: isSensitiveKey(key),
      editable: true,
    });
  }
  return rows;
}

/** A privacy summary line for the panel header. */
export interface MetadataSummary {
  total: number;
  sensitive: number;
  tagCount: number;
  xattrCount: number;
  label: string;
}

export function summarize(inspect: MetadataInspectResult): MetadataSummary {
  const rows = buildMetadataRows(inspect);
  const sensitive = rows.filter((r) => r.sensitive).length;
  const tagCount = inspect.tagCount ?? Object.keys(inspect.tags ?? {}).length;
  const xattrCount = (inspect.xattrs ?? []).length;
  const label =
    sensitive === 0
      ? `${rows.length} fields — no obvious privacy leaks`
      : `${sensitive} of ${rows.length} fields may leak personal/location/device info`;
  return { total: rows.length, sensitive, tagCount, xattrCount, label };
}

/** The destructive-erase confirm gate (the typed-confirm UX state). */
export type ConfirmGate = "idle" | "confirming" | "applying" | "done" | "error";

/** Whether the erase action can fire (a non-empty file + not mid-flight). */
export function canScrub(filePath: string | null, gate: ConfirmGate): boolean {
  return filePath !== null && gate !== "applying";
}
