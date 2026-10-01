// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/in.ts — `/in`: where produced files go.
 *
 * `/cd` moves where Prometheus READS. `/in` moves where it WRITES the things it produces —
 * a downloaded video, a converted image, an extracted PDF page — without moving the session
 * out of the project it is working on. Two ways in, one meaning:
 *
 *   /in ~/Downloads                          set it for the session
 *   "download this video … and save it /in ~/Downloads"    set it for one turn, inline
 *
 * The inline form is the point: the destination is named in the same breath as the request,
 * so the model never has to guess and the user never has to run a second command.
 *
 * WHY THIS IS ALSO A PERMISSION, not just a preference. The exec sandbox's writable set is
 * `[session cwd, ...workingSet]` (agent/system/host/system-tools.ts), so a command told to
 * write into `~/Downloads` while the session sits in a project would be DENIED by Seatbelt —
 * silently, as far as the model is concerned. `/in` therefore grants the directory in the
 * working set as it sets it. That is the same grant `/add-dir` makes and it is made the same
 * way: only ever from a path the HUMAN typed, never one the model chose. A model asking to
 * write somewhere still cannot; a user saying `/in` there can.
 *
 * `/paths` (session/onboarding.ts) owns the PERSISTENT per-category download folders
 * (open models, videos, audio, files) in `paths.json`. `/in` deliberately does not touch
 * them: it is the session/turn-scoped override that wins while it is set, and forgetting it
 * is as easy as `/in --clear`.
 */
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { type ResolveResult, expandHome } from "@prometheus/core/agent-system-host";

import { shortCwd } from "../path-display.js";
import { c } from "../render.js";

const USAGE = "/in <folder> | /in | /in --clear";

/** What `/in <args>` asked for. */
export type InArgs =
  | { ok: true; action: "show" }
  | { ok: true; action: "clear" }
  | { ok: true; action: "set"; dir: string }
  | { ok: false; error: string };

/**
 * Expand `$VAR` / `${VAR}` from the environment, then `~`.
 *
 * The user types shell-shaped paths (`/Users/$USER/Downloads`) because that is what a path
 * looks like everywhere else; a slash command that took it literally would create a folder
 * called `$USER`. An unknown variable is left LITERAL rather than emptied, so a typo fails
 * loudly as "no such path" instead of silently resolving to the parent directory.
 */
export function expandVars(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (all, a, b) => {
      const v = env[(a ?? b) as string];
      return v === undefined ? all : v;
    },
  );
}

/** Expand vars + `~`, then resolve against the session cwd. */
export function resolveInPath(arg: string, cwd: string): string {
  const raw = expandHome(expandVars(arg.trim()));
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

/** Parse `/in` arguments. A quoted path may contain spaces; an unknown flag is an error. */
export function parseInArgs(rest: string): InArgs {
  const arg = rest.trim();
  if (!arg) return { ok: true, action: "show" };
  if (arg === "--clear" || arg === "-c" || arg === "off" || arg === "reset")
    return { ok: true, action: "clear" };
  if (arg.startsWith("-")) return { ok: false, error: `unknown option ${arg} — ${USAGE}` };
  const quoted = /^"([^"]+)"$|^'([^']+)'$/.exec(arg);
  return { ok: true, action: "set", dir: quoted ? ((quoted[1] ?? quoted[2]) as string) : arg };
}

export interface InDirective {
  /** the message with the `/in …` directive removed. */
  prompt: string;
  /** the raw path that followed `/in`, unresolved; null when there was no directive. */
  dir: string | null;
}

/**
 * Pull an inline `/in <folder>` out of a free-text message.
 *
 * Matched only as a whole token followed by whitespace, so `/info`, `/install` and a bare
 * trailing `/in` are all left alone. A quoted path may contain spaces. When the directive
 * appears more than once the LAST one wins — the natural reading of "… /in A … actually /in B"
 * — and every occurrence is stripped so no stray `/in` reaches the model.
 */
export function extractInDirective(text: string): InDirective {
  const re = /(^|\s)\/in\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  let dir: string | null = null;
  const prompt = text
    .replace(re, (_all, lead: string, dq?: string, sq?: string, bare?: string) => {
      dir = dq ?? sq ?? bare ?? null;
      return lead;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { prompt, dir };
}

/**
 * The sentence the model is told when an output directory is in force.
 *
 * Phrased as a fact plus an instruction because the model cannot discover it any other way:
 * the sandbox will simply refuse a write elsewhere, and a refusal it cannot explain is how
 * turns end in silence.
 */
export function outputDirNote(dir: string): string {
  return `Output directory for produced files: ${dir}\nWrite anything this turn produces (downloads, conversions, exports) into that folder — pass it explicitly to the command (for example \`-o\`, \`-P\`, or an absolute output path). It is writable; the session working directory is unchanged and still where you read from.`;
}

/** The session output directory, as the slash registry sees it. */
export interface OutputDirState {
  get: () => string | null;
  set: (dir: string) => ResolveResult;
  clear: () => void;
}

/**
 * Build the `/in` state over a host's working set.
 *
 * ONE implementation, shared by both terminal hosts and the test fixture, because the grant is
 * the security-relevant half: a site that set the directory without adding it to the working
 * set would produce a session where every download is refused by the OS sandbox with nothing
 * in the transcript to explain it.
 *
 * A directory that does not exist yet is CREATED (recursively). A download destination usually
 * does not exist until something is downloaded into it, and the alternative — making the user
 * leave the session to run `mkdir` — is the kind of papercut `/in` exists to remove. It mirrors
 * `setCategory` in home.ts, which has always done this for the `/paths` folders.
 */
export function createOutputDir(
  ws: { add: (dir: string, cwd: string) => ResolveResult },
  cwd: () => string,
): OutputDirState {
  let dir: string | null = null;
  return {
    get: () => dir,
    set: (arg) => {
      const abs = resolveInPath(arg, cwd());
      let res = ws.add(abs, cwd());
      if (!res.ok) {
        try {
          mkdirSync(abs, { recursive: true });
        } catch (e) {
          return { ok: false, error: `cannot create ${abs}: ${(e as Error).message}` };
        }
        res = ws.add(abs, cwd());
      }
      if (res.ok && res.resolved) dir = res.resolved;
      return res;
    },
    // The working-set grant is deliberately NOT revoked: the user asked for that folder once,
    // and silently taking read access away mid-session would break a later reference to a file
    // already downloaded there.
    clear: () => {
      dir = null;
    },
  };
}

/**
 * Apply `/in` to one outgoing user message: honour an inline directive, then tell the model
 * where to write. Returns the text actually sent.
 *
 * Called once per turn by both terminal hosts, so `"… save it /in ~/Downloads"` behaves the
 * same whichever one is running. The note is appended to the USER message rather than injected
 * as a preamble contributor on purpose: it is part of what the user asked for, it costs tokens
 * only on turns where an output folder is actually in force, and it stays visible in the
 * transcript — so a later reader can see why a file landed where it did.
 *
 * A destination that cannot be used is REPORTED and then ignored: the turn still runs, the
 * files land in the working directory, and the user has been told in plain words. Silently
 * writing somewhere else would be worse, and refusing the whole turn would be worse still.
 */
export function applyInDirective(
  text: string,
  out: OutputDirState,
  write: (line: string) => void,
): string {
  const { prompt, dir } = extractInDirective(text);
  let body = text;
  if (dir !== null) {
    body = prompt;
    const res = out.set(dir);
    if (res.ok && res.resolved) write(c.dim(`↳ output folder for this turn: ${res.resolved}`));
    else
      write(
        c.red(`/in: ${res.error ?? "could not use that folder"} — using the working directory`),
      );
  }
  const active = out.get();
  return active ? `${body}\n\n${outputDirNote(active)}` : body;
}

/** The `/in` status block: where writes go now, and how that was decided. */
export function formatInStatus(dir: string | null, cwd: string): string[] {
  if (!dir)
    return [
      `${c.bold("Output folder")}  ${c.dim("not set")}`,
      c.dim(`  produced files go to the working directory: ${shortCwd(cwd)}`),
      c.dim(`  set one with  /in <folder>   ·  or inline:  "… save it /in ~/Downloads"`),
    ];
  return [
    `${c.bold("Output folder")}  ${c.cyan(shortCwd(dir))}`,
    c.dim("  produced files go here, and the agent may write here"),
    c.dim(`  reading still happens in ${shortCwd(cwd)}  ·  /in --clear to unset`),
  ];
}
