// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * metadata.ts — the file-metadata control client (file 0C, privacy protection).
 *
 * A typed gateway over the `metadata.py` sidecar: inspect / scrub / edit / timestomp the
 * metadata of ONE user-selected file. Every MUTATING op is plan-only without
 * `confirm:true` (C5 — JS never silently mutates a file); the sidecar works on a copy +
 * verifies + atomically replaces, never losing the original on failure. `runSidecar`
 * fail-closes on spawn/timeout/parse error (an `ok:false` envelope, never silent success).
 */
import { type SidecarEnvelope, type SidecarOptions, runSidecar } from "./sidecar-runner.js";

/** Filesystem-level metadata (os.stat). */
export interface FsMetadata {
  size: number;
  mode: string;
  mtime: number;
  atime: number;
  ctime: number;
  birthtime?: number;
  uid?: number | null;
  gid?: number | null;
}

/** Which optional tools the sidecar found (drives graceful-degrade in the UI). */
export interface MetadataTools {
  exiftool: boolean;
  pil: boolean;
  pikepdf: boolean;
}

/** A full metadata read (the `inspect` verb). */
export interface MetadataInspect {
  ok: boolean;
  file: string;
  mime: string;
  fs: FsMetadata;
  xattrs: string[];
  tagSource: "exiftool" | "pil" | "pikepdf" | "zip" | "none";
  tags: Record<string, string>;
  tagCount: number;
  tools: MetadataTools;
  error?: string;
}

/** The result of a scrub (plan when `planned`, else the applied delta). */
export interface MetadataScrub {
  ok: boolean;
  file: string;
  planned?: boolean;
  scrubbed?: boolean;
  before?: { tagCount: number; tags?: Record<string, string>; xattrs?: string[] };
  after?: { tagCount: number };
  removed?: number;
  xattrsRemoved?: number;
  note?: string;
  error?: string;
}

/** The result of editing one field (plan unless confirmed). */
export interface MetadataEdit {
  ok: boolean;
  file: string;
  field: string;
  value: string;
  planned?: boolean;
  edited?: boolean;
  note?: string;
  error?: string;
}

/** The result of timestamp normalization (plan unless confirmed). */
export interface MetadataTimestomp {
  ok: boolean;
  file: string;
  mtime: number;
  atime: number;
  planned?: boolean;
  stomped?: boolean;
  current?: FsMetadata;
  fs?: FsMetadata;
  note?: string;
  error?: string;
}

/** Construction options for the metadata client (sidecar dir / timeouts). */
export type MetadataClientOptions = SidecarOptions;

/** The typed metadata client (mirrors EnvClient/RepoClient). */
export class MetadataClient {
  private readonly opts: MetadataClientOptions;
  constructor(opts: MetadataClientOptions = {}) {
    this.opts = opts;
  }

  private run<T extends SidecarEnvelope>(argv: string[]): Promise<T> {
    return runSidecar<T>("metadata.py", argv, this.opts);
  }

  /** Read all metadata for a file. */
  inspect(uri: string): Promise<MetadataInspect> {
    return this.run<MetadataInspect & SidecarEnvelope>(["inspect", "--uri", uri]);
  }

  /** Strip all metadata (plan unless `confirm`). Copy-then-replace; original safe on failure. */
  scrub(uri: string, confirm = false): Promise<MetadataScrub> {
    return this.run<MetadataScrub & SidecarEnvelope>([
      "scrub",
      "--uri",
      uri,
      ...(confirm ? ["--confirm"] : []),
    ]);
  }

  /** Set one metadata field (needs exiftool; plan unless `confirm`). */
  edit(uri: string, field: string, value: string, confirm = false): Promise<MetadataEdit> {
    return this.run<MetadataEdit & SidecarEnvelope>([
      "edit",
      "--uri",
      uri,
      "--field",
      field,
      "--value",
      value,
      ...(confirm ? ["--confirm"] : []),
    ]);
  }

  /** Normalize file timestamps (plan unless `confirm`). */
  timestomp(
    uri: string,
    mtime: number,
    atime?: number,
    confirm = false,
  ): Promise<MetadataTimestomp> {
    return this.run<MetadataTimestomp & SidecarEnvelope>([
      "timestomp",
      "--uri",
      uri,
      "--mtime",
      String(mtime),
      ...(atime !== undefined ? ["--atime", String(atime)] : []),
      ...(confirm ? ["--confirm"] : []),
    ]);
  }
}

/** Construct a MetadataClient. */
export function createMetadataClient(opts: SidecarOptions = {}): MetadataClient {
  return new MetadataClient(opts);
}
