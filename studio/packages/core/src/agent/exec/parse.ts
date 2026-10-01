// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/exec/parse.ts — turn a shell command line into a STRUCTURE we can validate.
 *
 * This is the load-bearing module of full_wrapper_compose Phase 2, and the reason the plan
 * refused a plain `bash(cmd: string)` tool. A denylist over a shell string cannot hold —
 * `sudo` is not `$(echo c3Vkbw== | base64 -d)`, and no regex catches both — so instead of
 * pattern-matching the string we PARSE it, validate every resulting argv, and then run the
 * stages ourselves with real pipes and no shell anywhere.
 *
 * The model gets to write shell. We never run a shell.
 *
 * REJECT, NEVER STRIP. Every unsupported construct is a hard parse error. Silently removing
 * `$(rm -rf ~)` would produce a command that LOOKS approved in the confirm dialog and does
 * something else — the exact failure the whole design exists to prevent. A rejection, by
 * contrast, tells the model precisely what to rewrite.
 *
 * Supported: words, single/double quotes, `|`, `&&`, `||`, `;`, `>`, `>>`, `<`, `2>&1`, and
 * `$VAR` resolved ONLY from an explicit variable map the host supplies.
 *
 * Rejected: command substitution (`$(…)`, backticks), process substitution (`<(…)`),
 * `eval`/`exec`/`source`/`.`, background `&`, and any variable the host did not supply.
 *
 * PURE: no IO, no node. Every branch is unit-tested, including a standing red-team corpus.
 */

/** Where a stage's stdout/stderr/stdin goes. */
export interface Redirect {
  /**
   * Which stream this redirect rebinds.
   *
   * Derived from the fd designator, which is why the tokenizer has to parse `N>` properly:
   * an earlier version matched only the literal `2>&1` and let every other `N>` fall through
   * to the word scanner. `rm -rf build 2>/dev/null` then became argv `["rm","-rf","build","2"]`
   * with a STDOUT redirect — an extra path deleted and the stream silently swapped.
   */
  stream: "stdout" | "stderr" | "stdin";
  /** `file` writes/reads a path; `merge` is the `2>&1` case. */
  kind: "file" | "merge";
  /** for `kind:"file"` — the path, already expanded. */
  target?: string;
  /** for `kind:"file"` on stdout — append (`>>`) rather than truncate (`>`). */
  append?: boolean;
}

/** One process in a pipeline: a program plus its arguments, already split. */
export interface Stage {
  argv: string[];
  redirects: Redirect[];
}

/** Stages joined by `|` — one process group, stdout wired to the next stdin. */
export interface Pipeline {
  stages: Stage[];
}

/** How a pipeline follows the previous one. `first` is the head of the list. */
export type Sequencing = "first" | "and" | "or" | "then";

/** A pipeline plus how it is reached (`&&` runs only on success, `||` only on failure). */
export interface SequencedPipeline {
  sequencing: Sequencing;
  pipeline: Pipeline;
}

/** A whole command line: one or more pipelines joined by `&&` / `||` / `;`. */
export interface ParsedCommand {
  parts: SequencedPipeline[];
}

/** A refusal. `hint` is written for the MODEL — it should say what to do instead. */
export interface ParseFailure {
  ok: false;
  error: string;
  hint?: string;
}

export type ParseResult = { ok: true; command: ParsedCommand } | ParseFailure;

export interface ParseOptions {
  /**
   * The ONLY variables `$VAR` may resolve to.
   *
   * Not `process.env`. The environment holds API keys, and a command line is echoed into the
   * confirm dialog and into the audit log — `--header "Authorization: $ANTHROPIC_API_KEY"`
   * would print the key to both. The host seeds this with the same non-sensitive allowlist
   * `env_get` uses. An unlisted variable is a parse ERROR, not an empty string: silently
   * expanding `$TOKEN` to `""` turns `curl -H "auth: $TOKEN"` into a request the model did
   * not intend and cannot see it did not make.
   */
  vars?: Readonly<Record<string, string>>;
}

const MAX_LEN = 8192;

/** Programs that ARE a shell, whatever the registry says about their name. */
const NEVER_ARGV0 = new Set(["eval", "exec", "source", ".", "command", "builtin"]);

function fail(error: string, hint?: string): ParseFailure {
  return hint === undefined ? { ok: false, error } : { ok: false, error, hint };
}

/* ── tokenizer ───────────────────────────────────────────────────────────────*/

type Token =
  | { t: "word"; v: string }
  | { t: "op"; v: "|" | "&&" | "||" | ";" }
  /** a redirect, carrying the fd it rebinds (`2>` ⇒ fd 2) and, for `N>&M`, the target fd. */
  | { t: "op"; v: "write" | "append" | "read" | "dup"; fd: number; toFd?: number };

/**
 * Split the line into words and operators, expanding quotes and `$VAR` as we go.
 *
 * Quoting is tracked per-character rather than by regex because the whole point is to know
 * exactly which characters were QUOTED: a `|` inside quotes is data, a bare one is an
 * operator, and a scanner that cannot tell them apart is the bug this module exists to avoid.
 */
function tokenize(line: string, vars: Readonly<Record<string, string>>): Token[] | ParseFailure {
  const out: Token[] = [];
  let buf = "";
  let hasWord = false; // distinguishes an empty quoted word `""` from no word at all
  let i = 0;

  const pushWord = (): void => {
    if (hasWord) out.push({ t: "word", v: buf });
    buf = "";
    hasWord = false;
  };

  /** Expand `$NAME` / `${NAME}` from the host's map. Returns null on an unknown name. */
  const expand = (): { text: string } | ParseFailure => {
    i += 1; // consume '$'
    let braced = false;
    if (line[i] === "{") {
      braced = true;
      i += 1;
    }
    let name = "";
    while (i < line.length && /[A-Za-z0-9_]/.test(line[i] as string)) {
      name += line[i];
      i += 1;
    }
    if (braced) {
      if (line[i] !== "}") return fail("unterminated ${…} variable reference");
      i += 1;
    }
    if (!name) return fail("a bare `$` is not supported");
    if (!Object.hasOwn(vars, name)) {
      return fail(
        `variable $${name} is not available to commands`,
        "Only a fixed set of non-sensitive variables can be used. Write the value literally, " +
          "or use `env_get` to read an allowlisted one first.",
      );
    }
    return { text: vars[name] as string };
  };

  while (i < line.length) {
    const c = line[i] as string;

    // ── the rejections, checked before anything else can consume the characters ──
    if (c === "`") {
      return fail(
        "backtick command substitution is not supported",
        "Run the inner command as its own tool call and use the result.",
      );
    }
    if (c === "$" && line[i + 1] === "(") {
      return fail(
        "command substitution `$(…)` is not supported",
        "Run the inner command as its own tool call and use the result.",
      );
    }
    if ((c === "<" || c === ">") && line[i + 1] === "(") {
      return fail("process substitution `<(…)` / `>(…)` is not supported");
    }

    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return fail("unterminated single quote");
      buf += line.slice(i + 1, end);
      hasWord = true;
      i = end + 1;
      continue;
    }

    if (c === '"') {
      i += 1;
      for (;;) {
        if (i >= line.length) return fail("unterminated double quote");
        const d = line[i] as string;
        if (d === '"') {
          i += 1;
          break;
        }
        if (d === "`" || (d === "$" && line[i + 1] === "(")) {
          return fail("command substitution inside double quotes is not supported");
        }
        if (d === "\\" && i + 1 < line.length) {
          // inside double quotes a backslash only escapes these four (POSIX)
          const n = line[i + 1] as string;
          buf += '"$`\\'.includes(n) ? n : `\\${n}`;
          i += 2;
          continue;
        }
        if (d === "$") {
          const r = expand();
          if ("ok" in r) return r;
          buf += r.text;
          continue;
        }
        buf += d;
        i += 1;
      }
      hasWord = true;
      continue;
    }

    if (c === "\\") {
      if (i + 1 >= line.length) return fail("trailing backslash");
      buf += line[i + 1];
      hasWord = true;
      i += 2;
      continue;
    }

    if (c === "$") {
      const r = expand();
      if ("ok" in r) return r;
      buf += r.text;
      hasWord = true;
      continue;
    }

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      pushWord();
      i += 1;
      continue;
    }

    // ── operators ──
    if (c === "&") {
      if (line[i + 1] === ">") {
        return fail(
          "`&>` is not supported",
          "Write `> file 2>&1` instead — same effect, and it cannot be misread.",
        );
      }
      if (line[i + 1] === "&") {
        pushWord();
        out.push({ t: "op", v: "&&" });
        i += 2;
        continue;
      }
      return fail(
        "background execution `&` is not supported",
        "Commands run to completion so their output can be returned.",
      );
    }
    if (c === "|") {
      pushWord();
      if (line[i + 1] === "|") {
        out.push({ t: "op", v: "||" });
        i += 2;
      } else {
        out.push({ t: "op", v: "|" });
        i += 1;
      }
      continue;
    }
    if (c === ";") {
      pushWord();
      out.push({ t: "op", v: ";" });
      i += 1;
      continue;
    }
    // ── redirects, with an optional fd designator ──
    // A leading digit run is an FD only when it is a token of its own — `echo abc2>x` writes
    // the word `abc2`, exactly as a shell would, while `echo abc 2>x` redirects stderr. That
    // is what `!hasWord` encodes: nothing has been accumulated into the current word yet.
    {
      let j = i;
      let digits = "";
      if (!hasWord) {
        while (j < line.length && /[0-9]/.test(line[j] as string)) {
          digits += line[j];
          j += 1;
        }
      }
      const op = line[j];
      if ((op === ">" || op === "<") && (digits.length > 0 || j === i)) {
        pushWord();
        const fd = digits === "" ? (op === "<" ? 0 : 1) : Number(digits);
        // `N>&M` — duplicate one fd onto another.
        if (op === ">" && line[j + 1] === "&") {
          let k = j + 2;
          let target = "";
          while (k < line.length && /[0-9]/.test(line[k] as string)) {
            target += line[k];
            k += 1;
          }
          if (!target) return fail("`>&` with no target file descriptor");
          out.push({ t: "op", v: "dup", fd, toFd: Number(target) });
          i = k;
          continue;
        }
        const append = op === ">" && line[j + 1] === ">";
        out.push({ t: "op", v: op === "<" ? "read" : append ? "append" : "write", fd });
        i = j + (append ? 2 : 1);
        continue;
      }
    }

    buf += c;
    hasWord = true;
    i += 1;
  }
  pushWord();
  return out;
}

/* ── parser ──────────────────────────────────────────────────────────────────*/

/**
 * Parse a command line. Returns the structure, or a refusal explaining what to write instead.
 *
 * The returned argv arrays are the AUTHORITATIVE record of what will run: the classifier
 * reads them, the confirm dialog shows them, the audit log stores them, and the runner
 * spawns exactly them. Nothing downstream ever sees the original string again.
 */
export function parseCommand(line: string, opts: ParseOptions = {}): ParseResult {
  const src = (line ?? "").trim();
  if (!src) return fail("empty command");
  if (src.length > MAX_LEN) return fail(`command is too long (${src.length} > ${MAX_LEN})`);
  // A control character in a command line is either an accident or an attempt to hide
  // something from the confirm dialog the human reads.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(src)) {
    return fail("command contains control characters");
  }

  const tokens = tokenize(src, opts.vars ?? {});
  if (!Array.isArray(tokens)) return tokens;
  if (tokens.length === 0) return fail("empty command");

  const parts: SequencedPipeline[] = [];
  let sequencing: Sequencing = "first";
  let stages: Stage[] = [];
  let argv: string[] = [];
  let redirects: Redirect[] = [];

  const endStage = (): ParseFailure | null => {
    if (argv.length === 0) {
      return redirects.length > 0
        ? fail("a redirect with no command")
        : fail("empty pipeline stage");
    }
    const head = argv[0] as string;
    if (NEVER_ARGV0.has(head)) {
      return fail(
        `\`${head}\` is not supported`,
        "It runs an arbitrary string as code, which defeats the per-command checks. Call the " +
          "program directly instead.",
      );
    }
    stages.push({ argv, redirects });
    argv = [];
    redirects = [];
    return null;
  };

  const endPipeline = (): ParseFailure | null => {
    const e = endStage();
    if (e) return e;
    parts.push({ sequencing, pipeline: { stages } });
    stages = [];
    return null;
  };

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k] as Token;
    if (tok.t === "word") {
      argv.push(tok.v);
      continue;
    }
    switch (tok.v) {
      case "|": {
        const e = endStage();
        if (e) return e;
        break;
      }
      case "&&":
      case "||":
      case ";": {
        const e = endPipeline();
        if (e) return e;
        sequencing = tok.v === "&&" ? "and" : tok.v === "||" ? "or" : "then";
        break;
      }
      case "dup": {
        // `2>&1` is the case that matters: stderr onto stdout. Anything else (`1>&2`, `3>&1`)
        // is legal shell but has no meaning for a captured pipeline, so it is refused rather
        // than silently treated as the common case.
        if (tok.fd === 2 && tok.toFd === 1) {
          redirects.push({ stream: "stderr", kind: "merge" });
          break;
        }
        return fail(`\`${tok.fd}>&${tok.toFd}\` is not supported (only \`2>&1\`)`);
      }
      case "write":
      case "append":
      case "read": {
        const next = tokens[k + 1];
        if (!next || next.t !== "word") return fail("a redirect with no target file");
        k += 1;
        if (tok.v === "read") {
          if (tok.fd !== 0) return fail(`\`${tok.fd}<\` is not supported (only stdin)`);
          redirects.push({ stream: "stdin", kind: "file", target: next.v });
          break;
        }
        if (tok.fd !== 1 && tok.fd !== 2) {
          return fail(`\`${tok.fd}>\` is not supported (only stdout and stderr)`);
        }
        redirects.push({
          stream: tok.fd === 2 ? "stderr" : "stdout",
          kind: "file",
          target: next.v,
          append: tok.v === "append",
        });
        break;
      }
      default:
        return fail(`unsupported operator \`${(tok as { v: string }).v}\``);
    }
  }

  // a trailing `;` is idiomatic and harmless; a trailing `&&`/`||` is a truncated command
  if (argv.length === 0 && stages.length === 0 && parts.length > 0) {
    if (sequencing === "then") return { ok: true, command: { parts } };
    return fail(`command ends with a dangling \`${sequencing === "and" ? "&&" : "||"}\``);
  }
  const e = endPipeline();
  if (e) return e;
  return { ok: true, command: { parts } };
}

/** Every stage in a parsed command, flattened — what the classifier iterates. */
export function allStages(cmd: ParsedCommand): Stage[] {
  return cmd.parts.flatMap((p) => p.pipeline.stages);
}

/**
 * Render a parsed command back to a human-readable line.
 *
 * Used by the confirm dialog and the audit log. It renders the PARSE, not the input, so what
 * the human approves is what will actually run — if the two ever disagreed, this is where it
 * would be visible.
 */
/**
 * POSIX-quote one word so a shell reproduces it EXACTLY.
 *
 * Single quotes, because inside them a POSIX shell performs no processing whatsoever —
 * `$(…)`, backticks, `\`, `|`, `;` and whitespace are all inert. The `'\''` dance closes the
 * quote, emits an escaped literal quote, and reopens: the only way to get a `'` through.
 *
 * Exported because `propose_elevated` renders a line the HUMAN pastes into a real shell
 * (`agent/system/elevated.ts`), which is the one place in this stack where the output is
 * shell syntax rather than an argv. Double-quoting there would leave `$(…)` live.
 */
export function shellQuote(w: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;
}

export function formatCommand(cmd: ParsedCommand): string {
  const q = shellQuote;
  const stage = (s: Stage): string => {
    const red = s.redirects
      .map((r) => {
        if (r.kind === "merge") return "2>&1";
        if (r.stream === "stdin") return `< ${q(r.target ?? "")}`;
        // render the fd for stderr so the confirm prompt shows `2>` rather than a bare `>`
        const fd = r.stream === "stderr" ? "2" : "";
        return `${fd}${r.append ? ">>" : ">"} ${q(r.target ?? "")}`;
      })
      .join(" ");
    return [s.argv.map(q).join(" "), red].filter(Boolean).join(" ");
  };
  return cmd.parts
    .map((p, idx) => {
      const join =
        idx === 0 ? "" : p.sequencing === "and" ? "&& " : p.sequencing === "or" ? "|| " : "; ";
      return join + p.pipeline.stages.map(stage).join(" | ");
    })
    .join(" ");
}
