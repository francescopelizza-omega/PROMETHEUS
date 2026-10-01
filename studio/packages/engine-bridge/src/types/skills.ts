// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/skills.ts — the `skills list` envelope (file 02 §3.3).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json skills list` @ 0.15.0):
 *   {"command":"skills","ok":true,"action":"list",
 *    "skills_dir":"/Users/.../.claude/skills","skills":[]}
 * With skills installed, each entry carries its folder name + enabled state; the
 * folder was empty on the probed host so the per-skill fields below follow the
 * engine's documented skills model (name + enabled/muted state).
 */
import type { EnvelopeBase } from "./envelope.js";

/** One installed SKILL.md folder's record. */
export interface SkillEntry {
  name: string;
  /** enabled | disabled | muted — open string to track the engine's vocabulary. */
  state?: string;
  enabled?: boolean;
  muted?: boolean;
  /** absolute path of the skill folder, when the engine reports it. */
  path?: string;
}

export type SkillsEnvelope = EnvelopeBase<{
  command: "skills";
  /** the skills sub-action; "list" for `skills list`. */
  action: string;
  skills_dir: string;
  skills: SkillEntry[];
}>;
