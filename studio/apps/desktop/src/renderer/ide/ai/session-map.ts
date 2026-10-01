// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/session-map.ts — the PURE bidirectional mapper between the live AgentPane tab shape
 * (AiTurn[] = flat role/content turns) and the durable core `Session`/`SessionTurn` model
 * (APP-052). The two shapes predate each other, so we map explicitly (with tests) rather
 * than mutate either in place.
 *
 * A core SessionTurn groups ONE user prompt + the assistant events that followed it; the
 * live pane is a flat list. live→session GROUPS; session→live FLATTENS. Secrets never
 * enter a transcript — AiTurn carries only {role, content, checkpointId}, so nothing to
 * strip, but the mapper is the single choke point if that ever changes.
 */
import type { Session, SessionTurn } from "@prometheus/core/agent-session";

import type { AiTurn } from "../state/stores.js";

/** Rejects control chars (0x00–0x1f) in a filename without a literal control char in-source. */
const CONTROL_CHARS = /[\u0000-\u001f]/;

/** A filesystem-safe session id → its `<id>.jsonl` filename can't path-escape the fs IPC. */
export function isSafeSessionId(id: string): boolean {
  if (!id || id.length > 200) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return false;
  if (CONTROL_CHARS.test(id)) return false;
  // reserved Windows device names (case-insensitive, with/without extension).
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(id)) return false;
  return true;
}

/** Group a flat live transcript into core SessionTurns (one per user prompt). */
export function liveToSession(
  meta: { id: string; title: string; workspacePath?: string; createdAt: string; updatedAt: string },
  turns: readonly AiTurn[],
): Session {
  const sessionTurns: SessionTurn[] = [];
  let current: SessionTurn | null = null;
  let n = 0;
  const open = (prompt: string, checkpointId?: string): SessionTurn => {
    n += 1;
    const turn: SessionTurn = {
      id: `${meta.id}-t${n}`,
      turnNumber: n,
      prompt,
      events: [],
      ...(checkpointId ? { checkpointId } : {}),
      createdAt: meta.updatedAt,
    };
    sessionTurns.push(turn);
    current = turn;
    return turn;
  };
  for (const t of turns) {
    // A LOCAL turn (`/ls` output) is not part of the conversation: archiving it as assistant
    // text would hand it to the model as history the next time the session is resumed.
    if (t.local) continue;
    if (t.role === "user") {
      open(t.content, t.checkpointId);
    } else {
      // an assistant turn with no open user turn (rare) → a synthetic empty-prompt turn.
      const cur = current ?? open("");
      cur.events.push({ kind: "text", text: t.content });
    }
  }
  return {
    id: meta.id,
    title: meta.title,
    ...(meta.workspacePath ? { workspacePath: meta.workspacePath } : {}),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    turns: sessionTurns,
  };
}

/** Flatten a core Session back into the live pane's flat AiTurn list. */
export function sessionToLive(session: Session): AiTurn[] {
  const out: AiTurn[] = [];
  for (const t of session.turns) {
    out.push({
      role: "user",
      content: t.prompt,
      ...(t.checkpointId ? { checkpointId: t.checkpointId } : {}),
    });
    for (const e of t.events) {
      if (e.kind === "text") out.push({ role: "assistant", content: e.text });
    }
  }
  return out;
}
