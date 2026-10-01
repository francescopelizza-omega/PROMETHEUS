// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/session-id.ts — mint a fresh interactive-session id.
 *
 * Five 10-hex-digit groups, dash-joined (Claude-Code-style): `3f9a2b1c4d-7e6f5a4b3c-…`.
 * 25 random bytes = 50 hex chars = 5×10 exactly, so the grouping never needs padding.
 * `safeSessionId` (history-store.ts) already accepts this shape (`[A-Za-z0-9_-]+`), and it
 * coexists on disk with the older `base36(time)-base36(random)` ids this replaces — both are
 * just filenames to every reader.
 */
import { randomBytes } from "node:crypto";

export function newSessionId(): string {
  const hex = randomBytes(25).toString("hex");
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 10) groups.push(hex.slice(i, i + 10));
  return groups.join("-");
}
