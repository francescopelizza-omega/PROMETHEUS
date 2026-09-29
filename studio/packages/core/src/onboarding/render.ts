/**
 * onboarding/render.ts — the doctor report as lines a person can act on.
 *
 * Returns `string[]`, not a printed screen: the CLI colours them, the desktop puts them in a
 * pane, and a test asserts on them. No ANSI, no box-drawing, no assumption about width.
 *
 * ── THE ONE RULE THIS FILE ENFORCES ─────────────────────────────────────────────────────────
 *
 * Prose is translated; COMMANDS ARE NOT. Every line that the user is meant to type comes
 * straight from `Requirement.install` and is never passed through `t()`. A localised
 * `brew install ollama` does not run, and an instruction that looks authoritative and fails is
 * worse than no instruction at all.
 *
 * ── AND THE SHAPE THAT FOLLOWS FROM IT ──────────────────────────────────────────────────────
 *
 * Each blocker is rendered as: what it is · why it is needed · the command · what comes after.
 * The "why" is never omitted, even when it makes the output longer. A newcomer reading
 * "install ollama" cannot tell whether it is PROMETHEUS's dependency or an upsell, and that
 * doubt is what makes people close the terminal.
 */

import type { Translator } from "../i18n/index.js";
import {
  type DoctorReport,
  type MachineFacts,
  type RequirementResult,
  suggestModel,
} from "./doctor.js";

/** Bytes → a short human string. Locale-independent on purpose: a size is not prose. */
function gb(n: number): string {
  return `${(n / 1e9).toFixed(n < 1e10 ? 1 : 0)} GB`;
}

/** Marks used down the left edge. Plain ASCII so a bare terminal renders them. */
export const MARKS = Object.freeze({ ok: "✓", missing: "✗", idle: "•", unknown: "?" });

/**
 * One requirement, as a block.
 *
 * `indent` keeps the caller in charge of layout; this decides only what is said and in what
 * order.
 */
export function renderRequirement(
  r: RequirementResult,
  t: Translator,
  facts: MachineFacts,
): string[] {
  const lines: string[] = [];
  const mark = MARKS[r.state];
  const status =
    r.state === "ok"
      ? t.t("doctor.status.installed")
      : r.state === "idle"
        ? t.t("doctor.status.stopped")
        : r.state === "unknown"
          ? ""
          : t.t("doctor.status.missing");
  lines.push(`${mark} ${t.t(r.requirement.whatKey)}${status ? `  — ${status}` : ""}`);
  if (r.state === "ok") return lines;

  lines.push(`    ${t.t("doctor.label.why")}: ${t.t(r.requirement.whyKey)}`);

  /*
   * The model is the one requirement whose "command" depends on the machine, because the right
   * first model is the biggest one that fits the memory actually free. Suggesting a 40 GB model
   * to someone with 8 GB is the failure this whole feature exists to prevent.
   */
  if (r.requirement.id === "model") {
    const pick = suggestModel(facts.availableBytes);
    if (pick) {
      lines.push(
        `    ${t.t("need.model.suggest", {
          memory: gb(facts.availableBytes ?? 0),
          model: pick.tag,
          size: gb(pick.bytes),
        })}`,
      );
      lines.push(`    ${t.t("doctor.label.install")}:  ollama pull ${pick.tag}`);
    } else {
      lines.push(`    ${t.t("need.model.none")}`);
    }
    return lines;
  }

  // ollama installed but not serving: the fix is to START it, not to install it again.
  if (r.state === "idle") {
    lines.push(`    ${t.t("runner.notrunning")}`);
    return lines;
  }

  if (r.command) {
    lines.push(`    ${t.t("doctor.label.install")}:  ${r.command}`);
    // A command that pipes a download into a shell, or needs root, deserves a sentence — the
    // user is about to paste it, and being surprised afterwards is how trust is lost.
    if (/\|\s*sh\b|\|\s*bash\b/.test(r.command)) lines.push(`    ${t.t("common.nointernet")}`);
    if (/^sudo\b/.test(r.command)) lines.push(`    ${t.t("common.needsadmin")}`);
  } else {
    // No command for this platform. Say so and point at the project, rather than inventing one.
    lines.push(`    ${t.t("common.unknownos")}`);
  }
  if (r.requirement.docs) lines.push(`    ${t.t("doctor.label.docs")}: ${r.requirement.docs}`);
  if (r.requirement.afterKey)
    lines.push(`    ${t.t("doctor.label.then")}: ${t.t(r.requirement.afterKey)}`);
  return lines;
}

/** The whole report. */
export function renderDoctor(report: DoctorReport, t: Translator, facts: MachineFacts): string[] {
  const out: string[] = [t.t("doctor.title"), ""];

  if (report.ready) {
    out.push(t.t("doctor.ready.title"), t.t("doctor.ready.body"));
  } else {
    const n = report.blockers.length;
    out.push(t.t("doctor.blocked.title"));
    // Singular and plural are SEPARATE KEYS rather than one string with an "(s)": the two
    // forms differ by more than a suffix in most of the languages shipped here.
    out.push(t.t(n === 1 ? "doctor.blocked.body" : "doctor.blocked.body.plural", { count: n }));
  }
  out.push("");

  for (const r of report.blockers) {
    out.push(...renderRequirement(r, t, facts));
    out.push("");
  }

  const rest = report.optional.filter((r) => r.state !== "ok");
  if (rest.length > 0) {
    out.push(t.t("doctor.optional.title"), t.t("doctor.optional.body"), "");
    for (const r of rest) {
      out.push(...renderRequirement(r, t, facts));
      out.push("");
    }
  }

  if (!report.ready) {
    // Said once, at the end, where a user who is about to paste commands will read it.
    out.push(t.t("common.safe"));
    out.push(t.t("common.gated"));
    out.push(t.t("doctor.recheck"));
    // A local model is not the only route, and someone who does not want a 5 GB download
    // should learn that here rather than after giving up.
    out.push("", t.t("cloud.alternative.title"), t.t("cloud.alternative.body"));
  }
  return out;
}

/** The guided walkthrough, for `/guide`. Static text; the doctor is what reads the machine. */
export function renderGuide(t: Translator): string[] {
  const steps = [1, 2, 3, 4, 5] as const;
  const out: string[] = [t.t("guide.title"), ""];
  for (const n of steps) {
    out.push(t.t("guide.step", { n, total: steps.length }));
    out.push(t.t(`guide.step${n}.title` as "guide.step1.title"));
    out.push(t.t(`guide.step${n}.body` as "guide.step1.body"));
    out.push("");
  }
  out.push(t.t("guide.done"));
  return out;
}
