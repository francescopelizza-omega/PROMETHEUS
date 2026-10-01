// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/question.ts — the agent asks the user, instead of guessing.
 *
 * `modes.ts` has declared a `question` descriptor since it was written, with zero production
 * references — no schema, no dispatch, no host seam. So an agent that hit a genuine ambiguity had
 * exactly two options: pick one and hope, or refuse. Both are worse than asking. A wrong
 * assumption is the expensive kind of failure precisely because it is silent — the work looks
 * finished and is finished to the wrong specification.
 *
 * THE COST OF GETTING THIS WRONG IS THE OPPOSITE FAILURE. A tool that asks is a tool a weak model
 * will reach for instead of working: three questions before reading a file, or a question whose
 * answer is in the file it was about to open. So this module is mostly guardrails —
 *
 *  - a per-TURN budget (not per-call), so a loop cannot fund an interrogation;
 *  - a description that names the one case it is for and the cases it is NOT for;
 *  - an honest refusal when no host can ask, which reaches the model as an instruction to
 *    proceed on a stated assumption rather than as a hang or a silent empty answer.
 *
 * PURE: no node, no IO. The host supplies the asking.
 */

import type { ToolDef } from "./tools.js";

/**
 * How many questions one user turn may fund.
 *
 * Per TURN rather than per call, for the same reason the spawn budget is: a per-call cap is not
 * a cap at all, because the loop simply makes another call. Three is enough for a genuine
 * multi-part ambiguity and far too few to hold a conversation instead of working.
 */
export const DEFAULT_MAX_QUESTIONS = 3;

/** The per-turn asking budget. Mutated as questions are asked; re-made each turn. */
export interface QuestionBudget {
  asked: number;
  maxQuestions: number;
}

export function initialQuestionBudget(over: Partial<QuestionBudget> = {}): QuestionBudget {
  return { asked: 0, maxQuestions: DEFAULT_MAX_QUESTIONS, ...over };
}

/** Whether another question may be asked, and if not, what the model should do instead. */
export function canAsk(
  budget: QuestionBudget,
): { allowed: true } | { allowed: false; reason: string } {
  if (budget.asked >= budget.maxQuestions) {
    return {
      allowed: false,
      reason: [
        `you have already asked ${budget.asked} question(s) this turn, which is the limit.`,
        "Choose the most reasonable interpretation, SAY which one you chose and why, and",
        "continue. Do not ask again.",
      ].join(" "),
    };
  }
  return { allowed: true };
}

/** What the model is told when no host can prompt a human. Actionable, never a hang. */
export const NO_ASKER_MESSAGE =
  "There is no interactive user available in this session, so your question cannot be " +
  "answered. Do NOT wait and do NOT ask again. Choose the most reasonable interpretation, " +
  "state the assumption you made in your final answer, and continue.";

/**
 * `question` — ask the user one clarifying question and wait for the answer.
 *
 * `readOnlyHint` is TRUE and that is deliberate: it changes nothing on the machine, and the
 * §4.3 broker would otherwise route it to a confirm — asking the human to approve being asked a
 * question, then asking it. The question IS the prompt; a confirm in front of it is noise the
 * user would learn to click through.
 */
export const QUESTION_TOOL: ToolDef = {
  name: "question",
  title: "Ask the user",
  description:
    "Ask the user ONE short clarifying question and wait for their answer. Use this ONLY when " +
    "the task is genuinely ambiguous and the answer would change what you build — a choice " +
    "between two valid designs, a missing name or path you cannot infer, a destructive step " +
    "you want confirmed in words. Do NOT use it for anything you can find by reading a file, " +
    "listing a directory or searching the repo; look first. Do NOT use it to narrate progress " +
    "or to ask permission for a tool call (tools have their own approval). Prefer making a " +
    "reasonable assumption and stating it over asking a question whose answer barely matters.",
  schema: {
    question: {
      type: "string",
      required: true,
      description: "the question, one sentence, answerable in a few words",
    },
    context: {
      type: "string",
      description: "one line on why you are asking — what you will do differently either way",
    },
  },
  annotations: { readOnlyHint: true, idempotentHint: false },
  toArgv: () => {
    throw new Error("question is served by the host runtime, not by prometheus.py");
  },
};

/** Render the prompt a host shows the human. `context` earns its line only when it exists. */
export function renderQuestion(args: Record<string, unknown>): string {
  const q = typeof args.question === "string" ? args.question.trim() : "";
  const ctx = typeof args.context === "string" ? args.context.trim() : "";
  if (!q) return "";
  return ctx ? `${q}\n  (${ctx})` : q;
}

/**
 * The answer, as the model will read it.
 *
 * An EMPTY answer is reported as empty rather than as silence: "the user did not answer" and
 * "the user answered with nothing" would otherwise be indistinguishable, and the model's next
 * move differs — the first means proceed on an assumption, the second may mean "no preference,
 * you choose".
 */
export function renderAnswer(answer: string): string {
  const a = answer.trim();
  return a === ""
    ? "The user gave no answer. Proceed with the most reasonable interpretation and say which one you chose."
    : `The user answered: ${a}`;
}
