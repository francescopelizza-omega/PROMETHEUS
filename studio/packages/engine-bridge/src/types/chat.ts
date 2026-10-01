// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/chat.ts — the `chat` envelopes (agentic-local response + terminal preview).
 *
 * Two shapes share command "chat" (so they are NOT in the discriminated union —
 * callers select by facade method):
 *  - AGENTIC: `chat --local <model> "prompt"` →
 *      {"command":"chat","ok":true,"mode":"local","model":"...","runner":"ollama","response":"..."}
 *  - TERMINAL preview: `chat --cli <svc> ...` (no --open) →
 *      {"command":"chat","ok":true,"mode":"terminal","cli":"claude","label":"Claude Code",
 *       "argv":[...],"env":{...},"notes":[...],"bypass":false,"tmux":null,"interactive":true,"model":null}
 */
import type { EnvelopeBase } from "./envelope.js";

export type ChatLocalEnvelope = EnvelopeBase<{
  command: "chat";
  mode: "local";
  model: string;
  runner: string;
  response: string;
}>;

export type ChatTerminalEnvelope = EnvelopeBase<{
  command: "chat";
  mode: "terminal";
  cli: string;
  label: string;
  /** the validated argv that the OPEN button would exec (injection-safe). */
  argv: string[];
  /** extra env overrides (e.g. GEMINI_SYSTEM_MD). */
  env: Record<string, string>;
  /** advisory notes/warnings to surface in the preview. */
  notes: string[];
  bypass: boolean;
  /** tmux session name when wrapping, else null. */
  tmux: string | null;
  interactive: boolean;
  model: string | null;
  /** resolved working directory for the terminal session (the GUI ptySpawn cwd). */
  cwd: string;
}>;
