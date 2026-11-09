// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/platform.ts — what the HOST is, for labels only (never for security decisions).
 *
 * The shortcut hints said "⌘K" on Windows and Linux, where the key is Ctrl+K; a user there
 * read a key their keyboard does not have.
 */

export function isMacHost(): boolean {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  const p = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`.toLowerCase();
  return p.includes("mac");
}

/** The primary modifier as the user's keyboard shows it: "⌘" on macOS, "Ctrl+" elsewhere. */
export function modKey(): string {
  return isMacHost() ? "⌘" : "Ctrl+";
}
