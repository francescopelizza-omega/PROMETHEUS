// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/exec/privileged.ts — is this command privileged, and may the gate run it as written?
 *
 * The rule this serves: **Prometheus may run sudo, but never on its own authority.** Every
 * privileged command reaches ONE place — the privileged gate (`system/host/privileged-gate.ts`)
 * — which shows the human the exact argv and runs it only after that human approves that exact
 * command. This module decides what has to go there.
 *
 * It fails CLOSED in both directions that matter:
 *
 *  - **Privileged** is decided generously. An elevator (`sudo`, `doas`, `pkexec`, `su`, `run0`,
 *    `machinectl shell`, …) by name or absolute path, behind a launcher (`env`, `nice`,
 *    `timeout`, `xargs`, …), inside a `sh -c` string, anywhere in a pipeline or chain — all
 *    privileged. A line the parser cannot read that still NAMES an elevator is privileged too:
 *    "we could not tell" must never fall through to the auto-approving tier ladder. An unknown
 *    program that carries an elevator as an argument might be a launcher, so it counts.
 *  - **Runnable** is decided narrowly. The gate runs exactly one shape, `<elevator> -- program
 *    args…`, so what the human approves and what executes are the same words. Elevator options
 *    (`-u`, `-E`, `-s`, `-i`) change WHO runs it or open a root shell; a shell string, a
 *    launcher, a pipeline, a chain or a redirect hides part of the command from the reviewer.
 *    Each of those is still privileged, carries a `refusal` that tells the model what to write
 *    instead, and never reaches a prompt.
 *
 * PURE: no IO, no node.
 */

import { type ParseOptions, type Stage, allStages, parseCommand } from "./parse.js";
import { basename, programSpec } from "./registry.js";

/** Every program that raises privilege. Matched case-insensitively (APFS is case-insensitive). */
export type Elevator =
  | "sudo"
  | "doas"
  | "pkexec"
  | "su"
  | "run0"
  | "machinectl"
  | "gosu"
  | "runas"
  | "please"
  | "sudoedit";

const ELEVATORS: ReadonlySet<string> = new Set<Elevator>([
  "sudo",
  "doas",
  "pkexec",
  "su",
  "run0",
  "machinectl",
  "gosu",
  "runas",
  "please",
  "sudoedit",
]);

/** The elevators the gate knows how to drive. Every other one is privileged AND refused. */
export const GATE_ELEVATORS = ["sudo", "doas", "pkexec", "run0"] as const;
export type GateElevator = (typeof GATE_ELEVATORS)[number];

export interface PrivilegedClass {
  privileged: boolean;
  /** the elevator that made it privileged, when one was identified. */
  elevator?: Elevator;
  /** the one shape the gate runs: `<elevator> -- ...argv`. Absent whenever `refusal` is set. */
  canonical?: { elevator: GateElevator; argv: string[] };
  /** privileged, but not runnable as written — written for the MODEL: what to do instead. */
  refusal?: string;
  /** launchers peeled on the way to the elevator, outermost first. */
  via?: string[];
  /** the parser could not read the line, but it names an elevator. */
  ambiguous?: boolean;
}

/** Launchers: `LAUNCHER [opts] COMMAND [args]`. The value-taking options must be skipped. */
interface Launcher {
  valueOpts: readonly string[];
  /** positional operands BEFORE the command (`timeout DURATION cmd`, `chroot ROOT cmd`). */
  leading?: number;
  /** `NAME=value` operands are skipped (`env`). */
  assignments?: boolean;
}

const LAUNCHERS: Readonly<Record<string, Launcher>> = Object.freeze({
  env: { valueOpts: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], assignments: true },
  nice: { valueOpts: ["-n", "--adjustment"] },
  nohup: { valueOpts: [] },
  timeout: { valueOpts: ["-s", "--signal", "-k", "--kill-after"], leading: 1 },
  xargs: {
    valueOpts: ["-n", "-L", "-P", "-I", "-d", "-E", "-s", "-a", "--max-args", "--max-lines"],
  },
  command: { valueOpts: [] },
  exec: { valueOpts: ["-a"] },
  time: { valueOpts: ["-f", "--format", "-o", "--output"] },
  stdbuf: { valueOpts: ["-i", "-o", "-e"] },
  setsid: { valueOpts: [] },
  ionice: { valueOpts: ["-c", "-n", "-p", "-t"] },
  chrt: { valueOpts: [], leading: 1 },
  taskset: { valueOpts: [], leading: 1 },
  caffeinate: { valueOpts: ["-t", "-w"] },
  unbuffer: { valueOpts: [] },
  flock: { valueOpts: ["-w", "-E"], leading: 1 },
  chroot: { valueOpts: ["--userspec", "--groups"], leading: 1 },
  script: { valueOpts: ["-c", "-t", "-T", "-I", "-O", "-B"] },
  watch: { valueOpts: ["-n", "-d"] },
  strace: { valueOpts: ["-e", "-o", "-p", "-s", "-u"] },
});

const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "ash",
  "fish",
  "csh",
  "tcsh",
]);

/** Shell flags that mean "do not run a script file": an inline string, stdin, interactive. */
const SHELL_NO_SCRIPT = /^-[A-Za-z]*[csi][A-Za-z]*$/;

/** How deep `sh -c "env sh -c '…'"` nesting is followed before giving up (and failing closed). */
const MAX_DEPTH = 4;

const CONTROL = /[\u0000-\u001f\u007f]/;

/** The exact program name for launcher/shell lookups — `script.sh` is NOT the `script` launcher. */
function progName(word: string): string {
  return basename(word ?? "")
    .toLowerCase()
    .replace(/\.exe$/, "");
}

function family(word: string): string {
  const b = basename(word ?? "").toLowerCase();
  return b.includes(".") ? (b.split(".")[0] as string) : b;
}

/** The elevator a word names, if any — `/usr/bin/sudo`, `SUDO` and `runas.exe` included. */
function elevatorOf(word: string): Elevator | null {
  const b = basename(word ?? "").toLowerCase();
  if (ELEVATORS.has(b)) return b as Elevator;
  const f = family(word);
  return ELEVATORS.has(f) ? (f as Elevator) : null;
}

/** Shell punctuation and whitespace — what separates command words inside a quoted string. */
const WORD_SPLIT = /[\s;&|()<>`'"$={}\\:!]+/;

/**
 * Does any of these words name an elevator? The fail-closed backstop for opaque launchers.
 *
 * Each argument is split into shell words first: `tmux new -d 'sudo -n id'` hands `sudo -n id`
 * over as ONE argument, and its basename is not `sudo`. An unknown program carrying such a
 * string may well run it, so it counts — a false positive costs a refusal with a reason.
 */
function namesElevator(words: readonly string[]): Elevator | null {
  for (const w of words) {
    for (const piece of w.split(WORD_SPLIT)) {
      if (!piece) continue;
      const e = elevatorOf(piece);
      if (e) return e;
    }
  }
  return null;
}

/** Skip a launcher's options and operands; return the index of the command it launches. */
function launchedIndex(argv: readonly string[], spec: Launcher): number {
  let i = 1;
  let leading = spec.leading ?? 0;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (a === "--") return i + 1 + leading;
    if (a.startsWith("-") && a.length > 1) {
      // `-n 5` consumes the next token; `-n5`, `--adjustment=5` and `-oL` carry their own.
      if (spec.valueOpts.includes(a)) i += 1;
      i += 1;
      continue;
    }
    if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      i += 1;
      continue;
    }
    if (leading > 0) {
      leading -= 1;
      i += 1;
      continue;
    }
    return i;
  }
  return i;
}

/** For `sh -c STRING`: the inline string, or null when the shell runs a script file. */
function shellString(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return null;
    if (!a.startsWith("-")) return null; // the first operand is a script path
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
      // the string is the first operand after the option cluster(s)
      for (let j = i + 1; j < argv.length; j++) {
        const b = argv[j] as string;
        if (!b.startsWith("-")) return b;
      }
      return "";
    }
  }
  return null;
}

/** A stage's verdict before the whole-command rules (pipelines, chains) are applied. */
interface StageVerdict {
  elevator: Elevator;
  via: string[];
  refusal?: string;
  canonical?: { elevator: GateElevator; argv: string[] };
  ambiguous?: boolean;
}

const REWRITE =
  "Call propose_elevated with the program and its arguments only (no elevator, no options, " +
  "no shell): the gate runs `sudo -- <program> <args>` exactly as the human approves it.";

/** Validate what follows an elevator the gate drives, and build the canonical form. */
function canonicalAfter(elevator: Elevator, argv: readonly string[]): StageVerdict {
  const base: StageVerdict = { elevator, via: [] };
  if (!(GATE_ELEVATORS as readonly string[]).includes(elevator)) {
    const why =
      elevator === "su" || elevator === "machinectl"
        ? `\`${elevator}\` opens a root shell, which no one can review`
        : elevator === "sudoedit"
          ? "`sudoedit` opens an interactive editor as root"
          : `\`${elevator}\` is not an elevator the gate drives`;
    return { ...base, refusal: `${why}. ${REWRITE}` };
  }
  let i = 1;
  if (argv[i] === "--") i += 1;
  else if ((argv[i] ?? "").startsWith("-")) {
    return {
      ...base,
      refusal: `\`${elevator} ${argv[i]}\`: elevator options are not supported — they change who runs the command or open a root shell. ${REWRITE}`,
    };
  }
  const inner = argv.slice(i);
  if (inner.length === 0) {
    return { ...base, refusal: `\`${elevator}\` with no command opens a root shell. ${REWRITE}` };
  }
  const head = inner[0] as string;
  if (elevatorOf(head)) {
    return { ...base, refusal: `nested elevators (\`${elevator} ${head}\`). ${REWRITE}` };
  }
  const launcher = LAUNCHERS[progName(head)];
  if (launcher || progName(head) === "eval") {
    return {
      ...base,
      refusal: `\`${head}\` hides the real program one argument deeper, so the human cannot review it. ${REWRITE}`,
    };
  }
  if (SHELLS.has(progName(head))) {
    const rest = inner.slice(1);
    const script = rest.find((a) => !a.startsWith("-"));
    if (!script || rest.some((a) => SHELL_NO_SCRIPT.test(a))) {
      return {
        ...base,
        refusal: `\`${head}\` without a script file runs an inline string or a root shell. Put the commands in a script and propose \`${head} <script>\`, or propose each program directly.`,
      };
    }
  }
  if (inner.some((w) => CONTROL.test(w))) {
    return {
      ...base,
      refusal:
        "a newline or control character in an argument would make the reviewed line differ from what runs",
    };
  }
  return { ...base, canonical: { elevator: elevator as GateElevator, argv: [...inner] } };
}

/** Classify one argv. Returns null when it is not privileged. */
function stageVerdict(argv: readonly string[], depth: number): StageVerdict | null {
  if (argv.length === 0) return null;
  const head = argv[0] as string;
  const fam = progName(head);

  const elevator = elevatorOf(head);
  if (elevator) {
    // `machinectl list` is not privileged; `machinectl shell` is.
    if (elevator === "machinectl" && !argv.slice(1).some((a) => a === "shell" || a === "login")) {
      return null;
    }
    return canonicalAfter(elevator, argv);
  }

  const launcher = LAUNCHERS[fam];
  if (launcher) {
    const idx = launchedIndex(argv, launcher);
    const inner = stageVerdict(argv.slice(idx), depth);
    if (inner) {
      return {
        elevator: inner.elevator,
        via: [fam, ...inner.via],
        refusal: `\`${fam}\` launches \`${inner.elevator}\` one argument deeper. ${REWRITE}`,
        ...(inner.ambiguous ? { ambiguous: true } : {}),
      };
    }
    // `env -S "sudo id"` and friends: an elevator in the launcher's own arguments still counts.
    const named = namesElevator(argv.slice(1));
    return named
      ? {
          elevator: named,
          via: [fam],
          ambiguous: true,
          refusal: `\`${fam}\` may launch \`${named}\`. ${REWRITE}`,
        }
      : null;
  }

  if (SHELLS.has(fam)) {
    const str = shellString(argv);
    if (str !== null) {
      if (depth >= MAX_DEPTH) {
        const named = namesElevator(str.split(/\s+/));
        return named
          ? { elevator: named, via: [fam], ambiguous: true, refusal: `nested shells. ${REWRITE}` }
          : null;
      }
      const inner = classifyPrivilegedAt(str, depth + 1);
      if (inner.privileged) {
        return {
          elevator: inner.elevator ?? "sudo",
          via: [fam, ...(inner.via ?? [])],
          refusal: `\`${fam} -c\` hides the privileged command inside a string. ${REWRITE}`,
          ...(inner.ambiguous ? { ambiguous: true } : {}),
        };
      }
      return null;
    }
    const named = namesElevator(argv.slice(1));
    return named
      ? {
          elevator: named,
          via: [fam],
          ambiguous: true,
          refusal: `\`${fam}\` may run \`${named}\`. ${REWRITE}`,
        }
      : null;
  }

  // A known program's arguments are data (`grep sudo /etc/group`). An UNKNOWN program's might
  // be a command line it launches, so an elevator among them counts.
  if (programSpec(head)) return null;
  const named = namesElevator(argv.slice(1));
  return named
    ? {
        elevator: named,
        via: [fam],
        ambiguous: true,
        refusal: `\`${fam}\` is not a known program and its arguments name \`${named}\`. ${REWRITE}`,
      }
    : null;
}

/** Raw-text backstop for a line the parser refused: does it NAME an elevator anywhere? */
function rawElevator(line: string): Elevator | null {
  return namesElevator([line]);
}

function classifyPrivilegedAt(
  input: string | readonly string[],
  depth: number,
  opts: ParseOptions = {},
): PrivilegedClass {
  let stages: Stage[];
  if (typeof input === "string") {
    const parsed = parseCommand(input, opts);
    if (!parsed.ok) {
      const named = rawElevator(input);
      return named
        ? {
            privileged: true,
            elevator: named,
            ambiguous: true,
            refusal: `the command could not be parsed (${parsed.error}) and it names \`${named}\`. ${REWRITE}`,
          }
        : { privileged: false };
    }
    stages = allStages(parsed.command);
  } else {
    if (!Array.isArray(input) || !input.every((w) => typeof w === "string")) {
      return { privileged: false };
    }
    stages = [{ argv: [...input], redirects: [] }];
  }

  for (const st of stages) {
    const v = stageVerdict(st.argv, depth);
    if (!v) continue;
    const out: PrivilegedClass = { privileged: true, elevator: v.elevator };
    if (v.via.length) out.via = v.via;
    if (v.ambiguous) out.ambiguous = true;
    if (v.refusal) out.refusal = v.refusal;
    else if (stages.length > 1) {
      out.refusal = `the privileged command is one part of a pipeline or chain. Run the other parts separately, then ${REWRITE}`;
    } else if (st.redirects.length > 0) {
      out.refusal = `redirects are applied by your shell, not as root, so they would not do what the line says. ${REWRITE}`;
    } else if (v.canonical) out.canonical = v.canonical;
    return out;
  }
  return { privileged: false };
}

/**
 * Classify a command line (parsed with the same parser `run_command` uses) or an argv.
 *
 * `privileged: false` means no elevator can be reached. `privileged: true` with `canonical`
 * means the gate may offer it to the human; with `refusal`, it never reaches a prompt.
 */
export function classifyPrivileged(
  input: string | readonly string[],
  opts: ParseOptions = {},
): PrivilegedClass {
  return classifyPrivilegedAt(input, 0, opts);
}

/* ── catastrophic targets ─────────────────────────────────────────────────── */

/** Programs that only READ the files they are given. */
const READERS: ReadonlySet<string> = new Set([
  "cat",
  "less",
  "more",
  "head",
  "tail",
  "grep",
  "egrep",
  "rg",
  "ls",
  "stat",
  "file",
  "wc",
  "diff",
  "cmp",
  "md5",
  "md5sum",
  "sha256sum",
  "shasum",
  "bat",
]);

const DISK_TOOLS: ReadonlySet<string> = new Set([
  "fdisk",
  "sfdisk",
  "cfdisk",
  "gdisk",
  "sgdisk",
  "parted",
  "wipefs",
  "blkdiscard",
  "shred",
]);

const FORMATTERS: ReadonlySet<string> = new Set([
  "mkfs",
  "mke2fs",
  "newfs",
  "newfs_apfs",
  "mkswap",
]);

function stripSlashes(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** `/`, `/*`, `~`, `$HOME`, the home dir itself, or anything one level under `/`. */
function isSweepingTarget(t: string, home?: string): boolean {
  if (["/", "/*", "~", "~/", "~/*", "$HOME", "${HOME}"].includes(t)) return true;
  if (home && [home, `${stripSlashes(home)}/*`].includes(stripSlashes(t))) return true;
  return /^\/[^/]+\/?\*?$/.test(t);
}

function operands(rest: readonly string[]): { flags: string[]; args: string[] } {
  const flags: string[] = [];
  const args: string[] = [];
  let ended = false;
  for (const a of rest) {
    if (!ended && a === "--") {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith("-") && a.length > 1) flags.push(a);
    else args.push(a);
  }
  return { flags, args };
}

/**
 * The text the human must TYPE to approve a catastrophic command, or null for an ordinary one.
 *
 * The target itself, not a fixed word: typing `/dev/disk4` is a moment of reading what is
 * about to be erased, where a fixed phrase becomes muscle memory by the third time.
 */
export function catastrophicTarget(argv: readonly string[], home?: string): string | null {
  if (argv.length === 0) return null;
  const prog = family(argv[0] as string);
  const { flags, args } = operands(argv.slice(1));
  const short = flags.filter((f) => !f.startsWith("--")).join("");
  const recursive = /[rR]/.test(short) || flags.includes("--recursive");

  if (prog === "visudo") return "sudoers";
  if (!READERS.has(prog) && argv.slice(1).some((a) => /(^|\/)etc\/sudoers/.test(a))) {
    return "sudoers";
  }
  if (prog === "rm" && recursive) return args.find((t) => isSweepingTarget(t, home)) ?? null;
  if ((prog === "chmod" || prog === "chown" || prog === "chgrp") && recursive) {
    return args.slice(1).find((t) => isSweepingTarget(t, home)) ?? null;
  }
  if (prog === "dd") {
    const of = argv.find((a) => a.startsWith("of=/dev/"));
    return of ? of.slice(3) : null;
  }
  if (FORMATTERS.has(prog) || DISK_TOOLS.has(prog)) return args[args.length - 1] ?? prog;
  if (prog === "diskutil") {
    const erases = args.some((a) =>
      /^(erase|zero|random|secureerase|reformat|partition)|delete/i.test(a),
    );
    return erases ? (args[args.length - 1] ?? "diskutil") : null;
  }
  return null;
}
