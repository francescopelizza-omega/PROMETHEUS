/**
 * agent/protocol/parse.ts — read tool calls out of a model's PLAIN TEXT.
 *
 * Why this exists: the native transport (`tools:[…]` on the request, `delta.tool_calls` on
 * the response) only works when the endpoint's chat template knows how to render tools. A
 * large share of what Prometheus is pointed at does not — a GGUF served by a llama.cpp build
 * without `--jinja`, an Ollama model whose Modelfile carries no `.Tools` block, an OpenAI-
 * compatible shim in front of something else. For all of those, `supportsTools` is false and
 * the agent loop is handed an empty tool list, so the model can only ever DESCRIBE the work.
 *
 * The floor this module provides: teach the protocol in the prompt (see `preamble.ts`) and
 * read the calls back out of ordinary text. Every model can emit text.
 *
 * ONE dialect is taught, MANY are accepted. The taught form is `<tool_call>{…}</tool_call>`
 * because it is the form local instruct models are most likely to produce with no prompting
 * at all — it is what Qwen's and Hermes' own tool templates emit, so a model that ignores
 * our preamble and falls back on its training still lands somewhere we can read. The others
 * are here because a model under load reverts to whatever IT was tuned on, and refusing to
 * read Mistral's `[TOOL_CALLS]` would mean Mistral simply cannot act.
 *
 * THE RULE THAT KEEPS THIS SAFE: a call inside an ordinary fenced code block, OR inside an
 * inline `` `code span` ``, does NOT fire. "Show me how I'd read that file" must print an
 * example, not read the file. The scanner tracks fence AND inline-span state precisely for
 * that one reason.
 *
 * STREAMING: `ToolCallScanner` is incremental. A call split across SSE chunk boundaries —
 * the normal case, since a call is longer than one delta — is held back until it is whole.
 * It never emits half a call, and it never emits the leading bytes of a call as prose. A
 * call's JSON body is scanned INCREMENTALLY too (see `continueJsonScan`): each delta advances
 * a persisted cursor rather than re-walking everything buffered so far, so a large argument
 * (e.g. `write_file`'s `content`) streamed in small deltas costs O(body length) in total, not
 * O(body length²).
 *
 * PURE: no node, no IO.
 */

/** Which surface form a call arrived in. Kept for diagnostics and for the degrade decision. */
export type CallDialect =
  | "tool_call_tag"
  | "tool_call_attrs"
  | "tool_call_fence"
  | "mistral"
  | "python_tag"
  | "function_tag";

/** A tool call read out of text. `args` is always an object — never null, never an array. */
export interface TextToolCall {
  name: string;
  args: Record<string, unknown>;
  /** the exact source span, so a transcript can show what the model actually wrote. */
  raw: string;
  dialect: CallDialect;
}

/** Something that was CLEARLY meant to be a call but could not be read as one. */
export interface MalformedToolCall {
  raw: string;
  reason: string;
  dialect: CallDialect;
}

/** One scanner output. Text is everything that is not part of a call. */
export type ScanEvent =
  | { kind: "text"; text: string }
  | { kind: "call"; call: TextToolCall }
  | { kind: "malformed"; error: MalformedToolCall };

/* ── markers ─────────────────────────────────────────────────────────────────*/

interface Marker {
  open: string;
  dialect: CallDialect;
  /** consumed after the JSON payload when present; absence is tolerated. */
  close?: string;
  /** `<function=NAME>` carries the tool name in the tag rather than in the JSON. */
  nameInTag?: boolean;
  /**
   * A tag whose FORM is decided after the name: an optional number, then either `>` (a JSON
   * body) or attributes. Covers `<tool_call>`, `<tool_call1>` and `<tool_call name=…/>`.
   */
  family?: boolean;
  /** a closing tag with no opener — dropped as protocol residue. */
  orphanCloser?: boolean;
}

/**
 * Longest-first, because `<tool_call>` and `<tool_call_x>` would otherwise race and because
 * the hold-back below assumes a match at a position is the longest one available there.
 */
const MARKERS: readonly Marker[] = Object.freeze([
  { open: "<|python_tag|>", dialect: "python_tag" as const },
  { open: "```tool_call", dialect: "tool_call_fence" as const, close: "```" },
  { open: "```tool_code", dialect: "tool_call_fence" as const, close: "```" },
  { open: "[TOOL_CALLS]", dialect: "mistral" as const },
  { open: "<function=", dialect: "function_tag" as const, close: "</function>", nameInTag: true },
  // ONE entry for the whole `<tool_call…>` family, because a real gemma4:12b produced two
  // shapes neither a fixed `<tool_call>` string nor a hand-written corpus had anticipated:
  //   `<tool_call name="list_dir" arguments={"path": "."}/>`  — XML attributes, and an
  //      UNQUOTED JSON attribute value, which is not valid XML; and
  //   `<tool_call1>{"name":"list_dir","arguments":{}}</tool_call1>` — the tag NUMBERED, so a
  //      literal-string match rejects it as prose and the only call in the turn is lost.
  // The form is therefore decided after the tag name is read, not by which marker matched.
  { open: "<tool_call", dialect: "tool_call_tag" as const, family: true },
  { open: "<function", dialect: "function_tag" as const, family: true },
  // An ORPHAN closer. Models emit a stray `</tool_call>` with no opener surprisingly often —
  // the live gemma4 run opened a turn with one. It is protocol residue, never prose, so it is
  // swallowed rather than shown; leaving it in means the user reads `</tool_call>` in the
  // middle of an otherwise clean answer.
  { open: "</tool_call", dialect: "tool_call_tag" as const, orphanCloser: true },
  { open: "</function", dialect: "function_tag" as const, orphanCloser: true },
]);

/** `</tool_call>`, `</tool_call1>`, `</function>` — the closer, with its optional number. */
function closerLength(s: string, from: number, base: string): number {
  const lead = s.length - s.slice(from).trimStart().length - from;
  let i = from + lead;
  if (!s.startsWith(`</${base}`, i)) return 0;
  i += base.length + 2;
  while (i < s.length && /\d/.test(s[i] as string)) i += 1;
  return s[i] === ">" ? i + 1 - from : 0;
}

/** A generic fence opener/closer. Inside one of these, a call marker is INERT. */
const FENCE = "```";

/** How many trailing bytes may need to be held back as a possible partial marker. */
const MAX_HOLD = Math.max(...MARKERS.map((m) => m.open.length), FENCE.length) - 1;

/* ── balanced JSON scanning ──────────────────────────────────────────────────*/

type JsonScan = { ok: true; end: number } | { ok: false; why: "incomplete" | "invalid" };

/**
 * Find the end of the balanced JSON value starting at or after `from`.
 *
 * Searching for the closing MARKER instead would be simpler and wrong twice over: models
 * routinely omit the closing tag, and a `}` or a "```" inside a string argument (a grep
 * pattern, a file's contents) would end the scan early and truncate the call.
 */
export function scanJsonValue(s: string, from: number): JsonScan {
  let i = from;
  while (i < s.length && /\s/.test(s[i] as string)) i += 1;
  if (i >= s.length) return { ok: false, why: "incomplete" };
  const first = s[i];
  if (first !== "{" && first !== "[") return { ok: false, why: "invalid" };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < s.length; i += 1) {
    const c = s[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return { ok: true, end: i + 1 };
      if (depth < 0) return { ok: false, why: "invalid" };
    }
  }
  return { ok: false, why: "incomplete" };
}

/** Resumable progress for a balanced-JSON scan spread across many chunks. */
interface JsonProgress {
  pos: number;
  depth: number;
  inString: boolean;
  escaped: boolean;
  started: boolean;
}

type JsonScanResume =
  | { ok: true; end: number }
  | { ok: false; why: "invalid" }
  | { ok: false; why: "incomplete"; progress: JsonProgress };

/**
 * Same balance rules as `scanJsonValue`, but resumable: given the progress an earlier
 * incomplete call returned, continues from exactly where it left off instead of re-walking
 * bytes already classified.
 *
 * Without this, a call whose body streams in over many small deltas (a `write_file` with a
 * large `content` argument — the ordinary case, not an edge case, for how local runtimes
 * stream) gets rescanned from its start on every single delta: O(body length) work repeated
 * O(body length ÷ delta size) times, i.e. quadratic in the body length. `ToolCallScanner`
 * calls this once per call instead of `scanJsonValue`, carrying `JsonProgress` across pushes.
 */
function continueJsonScan(s: string, progress: JsonProgress): JsonScanResume {
  let i = progress.pos;
  let { depth, inString, escaped, started } = progress;
  if (!started) {
    while (i < s.length && /\s/.test(s[i] as string)) i += 1;
    if (i >= s.length) return { ok: false, why: "incomplete", progress: { ...progress, pos: i } };
    const first = s[i];
    if (first !== "{" && first !== "[") return { ok: false, why: "invalid" };
    started = true;
  }
  for (; i < s.length; i += 1) {
    const c = s[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return { ok: true, end: i + 1 };
      if (depth < 0) return { ok: false, why: "invalid" };
    }
  }
  return { ok: false, why: "incomplete", progress: { pos: i, depth, inString, escaped, started } };
}

/* ── XML attribute form ──────────────────────────────────────────────────────*/

type AttrScan =
  | { ok: true; attrs: Record<string, string>; end: number }
  | { ok: false; why: "incomplete" | "invalid" };

/**
 * Read `name="x" arguments={…}` up to the tag's `/>` or `>`.
 *
 * Deliberately looser than XML. The attribute value that prompted this was
 * `arguments={"path": "."}` — a raw JSON object where XML demands a quoted string — so the
 * value reader accepts a quoted string, a balanced JSON value, OR a bare token. A strict
 * parser would reject the only form the model actually emits.
 */
export function scanTagAttrs(s: string, from: number): AttrScan {
  const attrs: Record<string, string> = {};
  let i = from;
  for (;;) {
    while (i < s.length && /\s/.test(s[i] as string)) i += 1;
    if (i >= s.length) return { ok: false, why: "incomplete" };
    if (s.startsWith("/>", i)) return { ok: true, attrs, end: i + 2 };
    if (s[i] === ">") return { ok: true, attrs, end: i + 1 };
    // A trailing `/` is the first half of `/>` still in flight. Calling it invalid here is
    // what made a streamed attribute call vanish: the closing two bytes arrive in separate
    // deltas, and the scan gave up between them.
    if (s[i] === "/") return { ok: false, why: i + 1 >= s.length ? "incomplete" : "invalid" };

    // Tolerate stray closing punctuation between attributes. A real gemma4:12b emitted
    // `<tool_call name="read_file" arguments={"path": "answer.ts"}}>` — one `}` too many —
    // and hard-failing there threw away a call that was otherwise perfectly readable.
    // Deliberately limited to the characters a model over-emits when it miscounts brackets;
    // anything else is still a hard reject, because silently skipping unknown input is how a
    // parser starts inventing calls.
    if (/[}\])",;]/.test(s[i] as string)) {
      i += 1;
      continue;
    }
    const keyStart = i;
    while (i < s.length && /[\w:.-]/.test(s[i] as string)) i += 1;
    if (i === keyStart) return { ok: false, why: "invalid" };
    const key = s.slice(keyStart, i);
    while (i < s.length && /\s/.test(s[i] as string)) i += 1;
    if (i >= s.length) return { ok: false, why: "incomplete" };
    // A valueless attribute is legal XML; skip it rather than failing the whole call.
    if (s[i] !== "=") {
      attrs[key] = "";
      continue;
    }
    i += 1;
    while (i < s.length && /\s/.test(s[i] as string)) i += 1;
    if (i >= s.length) return { ok: false, why: "incomplete" };

    const q = s[i];
    if (q === '"' || q === "'") {
      let j = i + 1;
      let escaped = false;
      for (; j < s.length; j += 1) {
        const c = s[j] as string;
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === q) break;
      }
      if (j >= s.length) return { ok: false, why: "incomplete" };
      // Unescape only the two sequences a model actually produces here.
      attrs[key] = s
        .slice(i + 1, j)
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'");
      i = j + 1;
      continue;
    }
    if (q === "{" || q === "[") {
      const json = scanJsonValue(s, i);
      if (!json.ok) return { ok: false, why: json.why };
      attrs[key] = s.slice(i, json.end);
      i = json.end;
      continue;
    }
    const valStart = i;
    while (i < s.length && !/[\s>]/.test(s[i] as string) && !s.startsWith("/>", i)) i += 1;
    if (i >= s.length) return { ok: false, why: "incomplete" };
    attrs[key] = s.slice(valStart, i);
  }
}

/** Turn a scanned attribute set into events. */
function decodeAttrs(
  attrs: Record<string, string>,
  dialect: CallDialect,
  raw: string,
): ScanEvent[] {
  const name = (attrs.name ?? attrs.tool ?? attrs.tool_name ?? attrs.function ?? "").trim();
  if (!name) {
    return [{ kind: "malformed", error: { raw, dialect, reason: "no tool name in the call" } }];
  }
  const rawArgs = attrs.arguments ?? attrs.parameters ?? attrs.args ?? attrs.input;
  if (rawArgs === undefined || rawArgs.trim() === "") {
    return [{ kind: "call", call: { name, args: {}, raw, dialect } }];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return [
      {
        kind: "malformed",
        error: { raw, dialect, reason: `arguments for "${name}" are not valid JSON` },
      },
    ];
  }
  if (!isRecord(parsed)) {
    return [
      {
        kind: "malformed",
        error: { raw, dialect, reason: `arguments for "${name}" are not an object` },
      },
    ];
  }
  return [{ kind: "call", call: { name, args: parsed, raw, dialect } }];
}

/* ── payload normalisation ───────────────────────────────────────────────────*/

/** Keys a model might use for the tool's name, in preference order. */
const NAME_KEYS = ["name", "tool", "tool_name", "function", "recipient_name"] as const;
/** Keys a model might use for the arguments, in preference order. */
const ARG_KEYS = ["arguments", "parameters", "args", "input", "tool_input"] as const;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Coerce one decoded payload object into a name + args pair.
 *
 * `arguments` arriving as a JSON *string* is not a corner case: it is what OpenAI's own
 * native shape does, so every model fine-tuned on OpenAI transcripts reproduces it.
 */
function normaliseOne(
  value: unknown,
  tagName?: string,
): { name: string; args: Record<string, unknown> } | { error: string } {
  if (!isRecord(value)) return { error: "the payload is not a JSON object" };
  // A name in the TAG is authoritative: `<function=read_file>` already said which tool this
  // is, and a `name` key inside the payload of that form is part of the arguments.
  let name = tagName;
  if (!name) {
    for (const key of NAME_KEYS) {
      const v = value[key];
      if (typeof v === "string" && v.trim()) {
        name = v.trim();
        break;
      }
    }
  }
  if (!name) return { error: "no tool name in the call" };

  let rawArgs: unknown;
  let sawArgKey = false;
  for (const key of ARG_KEYS) {
    if (key in value) {
      rawArgs = value[key];
      sawArgKey = true;
      break;
    }
  }
  // `<function=read_file>{"path":"a.ts"}` wraps nothing — the payload IS the argument object.
  // Looking for an `arguments` key there finds none and silently calls the tool with {}.
  if (tagName && !sawArgKey) return { name, args: value };
  // A bare `{"name":"git_status"}` is a complete call to a no-argument tool — a third of the
  // catalog takes none, so treating a missing args key as an error would break those.
  if (rawArgs === undefined || rawArgs === null) return { name, args: {} };
  if (typeof rawArgs === "string") {
    const trimmed = rawArgs.trim();
    if (!trimmed) return { name, args: {} };
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) return { error: `arguments for "${name}" are not an object` };
      return { name, args: parsed };
    } catch {
      return { error: `arguments for "${name}" are not valid JSON` };
    }
  }
  if (!isRecord(rawArgs)) return { error: `arguments for "${name}" are not an object` };
  return { name, args: rawArgs };
}

/**
 * Decode a marker's JSON payload into zero or more calls.
 *
 * An ARRAY is a legitimate multi-call payload — Mistral's `[TOOL_CALLS]` is always one, and
 * models asked to do two independent reads often batch them.
 */
function decodePayload(
  json: string,
  dialect: CallDialect,
  raw: string,
  fallbackName?: string,
): ScanEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [{ kind: "malformed", error: { raw, dialect, reason: "the call is not valid JSON" } }];
  }
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) {
    return [{ kind: "malformed", error: { raw, dialect, reason: "the call list is empty" } }];
  }
  return items.map((item): ScanEvent => {
    const one = normaliseOne(item, fallbackName);
    if ("error" in one) {
      return { kind: "malformed", error: { raw, dialect, reason: one.error } };
    }
    return { kind: "call", call: { name: one.name, args: one.args, raw, dialect } };
  });
}

/* ── the incremental scanner ─────────────────────────────────────────────────*/

/** The next run of one or more backticks at or after `from`, and whether it runs all the way
 * to the end of `s` — meaning more backticks could still be coming in a later chunk. */
function nextBacktickRun(
  s: string,
  from: number,
): { at: number; len: number; boundedByEnd: boolean } | null {
  const at = s.indexOf("`", from);
  if (at === -1) return null;
  let len = 1;
  while (at + len < s.length && s[at + len] === "`") len += 1;
  return { at, len, boundedByEnd: at + len === s.length };
}

/** Where in `s` (at or after `from`) the earliest marker, fence, or inline code span starts. */
function nextMarker(
  s: string,
  from: number,
):
  | { at: number; marker: Marker }
  | { at: number; fence: true; boundedByEnd: boolean }
  | { at: number; codeSpan: number; boundedByEnd: boolean }
  | null {
  let bestMarker: { at: number; marker: Marker } | null = null;
  for (const marker of MARKERS) {
    const at = s.indexOf(marker.open, from);
    if (at !== -1 && (!bestMarker || at < bestMarker.at)) bestMarker = { at, marker };
  }
  const tick = nextBacktickRun(s, from);
  const backtickFound:
    | { at: number; fence: true; boundedByEnd: boolean }
    | { at: number; codeSpan: number; boundedByEnd: boolean }
    | null =
    tick === null
      ? null
      : tick.len >= FENCE.length
        ? { at: tick.at, fence: true, boundedByEnd: tick.boundedByEnd }
        : { at: tick.at, codeSpan: tick.len, boundedByEnd: tick.boundedByEnd };
  // A tie means the fence/span IS the head of a marker (e.g. ```tool_call) — the marker wins.
  if (bestMarker && (!backtickFound || bestMarker.at <= backtickFound.at)) return bestMarker;
  return backtickFound;
}

/** How many trailing bytes of `s` could be the start of a marker or fence. */
function holdBack(s: string): number {
  const start = Math.max(0, s.length - MAX_HOLD);
  for (let i = start; i < s.length; i += 1) {
    const tail = s.slice(i);
    for (const m of MARKERS) if (m.open.startsWith(tail)) return s.length - i;
    if (FENCE.startsWith(tail)) return s.length - i;
  }
  return 0;
}

/** State held across `push()` calls while a call's JSON body is still streaming in, or while
 * we're waiting to see whether its closing tag follows. Lets `drain` resume in O(new bytes)
 * on the next push instead of re-finding the marker and re-scanning the whole body — see
 * `continueJsonScan`. `this.buf` is always anchored so the call starts at index 0 while this
 * is set (holding-back always reslices to the marker start first), so `cursor`/`end` here are
 * plain indices into the CURRENT `this.buf`. */
type PendingCall =
  | {
      phase: "json";
      marker: Marker;
      dialect: CallDialect;
      cursor: number;
      fallbackName: string | undefined;
      progress: JsonProgress;
    }
  | {
      phase: "closer";
      marker: Marker;
      dialect: CallDialect;
      cursor: number;
      fallbackName: string | undefined;
      end: number;
    };

/**
 * A stateful, chunk-at-a-time reader over a model's text stream.
 *
 * Feed it every text delta with `push`; call `end` when the stream closes. It emits prose as
 * `text` events (byte-identical to the input once concatenated, minus the call spans) and
 * whole calls as `call` events.
 */
export class ToolCallScanner {
  private buf = "";
  /** Non-null while inside a fence or an inline code span; holds the exact delimiter that
   * closes it (``` for a fence, ` or `` for inline code) — a call marker is INERT in here. */
  private codeSpanCloser: string | null = null;
  /** Non-null while a call's JSON body (or its trailing closer) is still being awaited. */
  private pending: PendingCall | null = null;

  /** Feed one delta. Returns the events that are complete as of this chunk. */
  push(chunk: string): ScanEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  /**
   * Close the stream. A call still open at this point was TRUNCATED — the model ran out of
   * budget mid-call. It is reported malformed rather than flushed as prose, because prose
   * containing half a tool call is worse than an explicit "that call was cut off".
   */
  end(): ScanEvent[] {
    const events = this.drain(true);
    if (this.buf) {
      events.push({ kind: "text", text: this.buf });
      this.buf = "";
    }
    return events;
  }

  private drain(final: boolean): ScanEvent[] {
    const out: ScanEvent[] = [];
    for (;;) {
      if (this.pending) {
        const p = this.pending;
        if (p.phase === "json") {
          const r = continueJsonScan(this.buf, p.progress);
          const outcome = this.handleJsonScanResult(r, p, 0, final, out);
          if (outcome === "held") return out;
          continue;
        }
        const outcome = this.settleJsonEnd(p, p.end, 0, final, out);
        if (outcome === "held") return out;
        continue;
      }

      const found = nextMarker(this.buf, 0);
      if (!found) break;

      // A shorter marker can still grow into a longer one, and a short backtick run can still
      // grow into a longer one (a bare "``" one delta before a 3rd backtick turns it from an
      // inline span into a fence). Wait until the buffer can no longer become a longer match.
      if (!final) {
        const tail = this.buf.slice(found.at);
        const stillGrowing =
          MARKERS.some((m) => m.open.length > tail.length && m.open.startsWith(tail)) ||
          (!("marker" in found) && found.boundedByEnd);
        if (stillGrowing) return this.holdAndEmit(out, found.at);
      }

      if ("fence" in found) {
        const upto = found.at + FENCE.length;
        out.push({ kind: "text", text: this.buf.slice(0, upto) });
        this.buf = this.buf.slice(upto);
        if (this.codeSpanCloser === null || this.codeSpanCloser === FENCE) {
          this.codeSpanCloser = this.codeSpanCloser === FENCE ? null : FENCE;
        }
        // else: 3+ backticks while inside an inline span of a different length are just that
        // span's literal content — its own (shorter) closer hasn't arrived yet.
        continue;
      }

      if ("codeSpan" in found) {
        const delim = "`".repeat(found.codeSpan);
        const upto = found.at + found.codeSpan;
        out.push({ kind: "text", text: this.buf.slice(0, upto) });
        this.buf = this.buf.slice(upto);
        if (this.codeSpanCloser === null) this.codeSpanCloser = delim;
        else if (this.codeSpanCloser === delim) this.codeSpanCloser = null;
        // else: a different-length run (or one inside a fence) is literal content — unchanged.
        continue;
      }

      const { at, marker } = found;
      if (this.codeSpanCloser !== null) {
        // Inside a fence or an inline code span every marker is literal text — including a
        // ```tool_call, whose leading ``` is what CLOSES the fence we are in (an inline span
        // can only be closed by a matching short run, handled above, so this branch is the
        // fence case).
        if (marker.dialect === "tool_call_fence" && this.codeSpanCloser === FENCE) {
          const upto = at + FENCE.length;
          out.push({ kind: "text", text: this.buf.slice(0, upto) });
          this.buf = this.buf.slice(upto);
          this.codeSpanCloser = null;
          continue;
        }
        const upto = at + marker.open.length;
        out.push({ kind: "text", text: this.buf.slice(0, upto) });
        this.buf = this.buf.slice(upto);
        continue;
      }

      /** The tag base name (`tool_call` / `function`) without the leading `<` or `</`. */
      const base = marker.orphanCloser ? marker.open.slice(2) : marker.open.slice(1);

      if (marker.orphanCloser) {
        const len = closerLength(this.buf, at, base);
        if (len === 0) {
          // Not actually a closer (`</tool_calls>` in prose, or still arriving).
          if (!final && this.buf.length - at <= marker.open.length + 5) {
            return this.holdAndEmit(out, at);
          }
          out.push({ kind: "text", text: this.buf.slice(0, at + marker.open.length) });
          this.buf = this.buf.slice(at + marker.open.length);
          continue;
        }
        if (at > 0) out.push({ kind: "text", text: this.buf.slice(0, at) });
        // Dropped from the visible reply (never shown as prose), but not silently: a
        // `malformed` event still records it, so a stray closer isn't invisible to logs/tests.
        out.push({
          kind: "malformed",
          error: {
            raw: this.buf.slice(at, at + len),
            dialect: marker.dialect,
            reason: "a stray closing tag with no opener was dropped from the visible reply",
          },
        });
        this.buf = this.buf.slice(at + len);
        continue;
      }
      let cursor = at + marker.open.length;
      let dialect = marker.dialect;

      if (marker.family) {
        // Consume the optional NUMBER a model may append to the tag (`<tool_call1>`), then
        // decide the form from the character after it.
        let p = cursor;
        while (p < this.buf.length && /\d/.test(this.buf[p] as string)) p += 1;
        if (p >= this.buf.length) {
          if (!final) return this.holdAndEmit(out, at);
          out.push({ kind: "text", text: this.buf });
          this.buf = "";
          return out;
        }
        const ch = this.buf[p] as string;
        if (/[\w-]/.test(ch)) {
          // The tag name did not end — `<tool_calls>` in prose. Without this guard the `s`
          // reads as an attribute name and the user's own sentence vanishes from the
          // transcript, which is a silent edit to their text.
          out.push({ kind: "text", text: this.buf.slice(0, p) });
          this.buf = this.buf.slice(p);
          continue;
        }
        if (ch !== ">") {
          // Attributes: `<tool_call name="x" arguments={…}/>`.
          const scan = scanTagAttrs(this.buf, p);
          if (!scan.ok && scan.why === "incomplete") {
            if (!final) return this.holdAndEmit(out, at);
            out.push({
              kind: "malformed",
              error: {
                raw: this.buf.slice(at),
                dialect: "tool_call_attrs",
                reason: "the call was cut off before it finished",
              },
            });
            this.buf = "";
            return out;
          }
          if (!scan.ok) {
            out.push({ kind: "text", text: this.buf.slice(0, p) });
            this.buf = this.buf.slice(p);
            continue;
          }
          if (at > 0) out.push({ kind: "text", text: this.buf.slice(0, at) });
          const after = scan.end + closerLength(this.buf, scan.end, base);
          out.push(...decodeAttrs(scan.attrs, "tool_call_attrs", this.buf.slice(at, after)));
          this.buf = this.buf.slice(after);
          continue;
        }
        // `>` — a JSON body follows, exactly like the plain `<tool_call>` form.
        cursor = p + 1;
        dialect = marker.dialect;
      }

      let fallbackName: string | undefined;
      if (marker.nameInTag) {
        const gt = this.buf.indexOf(">", cursor);
        if (gt === -1) {
          if (!final) return this.holdAndEmit(out, at);
          out.push({
            kind: "malformed",
            error: {
              raw: this.buf.slice(at),
              dialect: marker.dialect,
              reason: "the call was cut off before its name closed",
            },
          });
          this.buf = "";
          return out;
        }
        fallbackName = this.buf.slice(cursor, gt).trim();
        cursor = gt + 1;
      }

      const r = continueJsonScan(this.buf, {
        pos: cursor,
        depth: 0,
        inString: false,
        escaped: false,
        started: false,
      });
      const outcome = this.handleJsonScanResult(
        r,
        { marker, dialect, cursor, fallbackName },
        at,
        final,
        out,
      );
      if (outcome === "held") return out;
    }

    // No marker anywhere in the buffer: emit it as prose, minus any tail that could still
    // turn out to be one.
    const hold = final ? 0 : holdBack(this.buf);
    const emit = this.buf.slice(0, this.buf.length - hold);
    if (emit) out.push({ kind: "text", text: emit });
    this.buf = this.buf.slice(this.buf.length - hold);
    return out;
  }

  /** Emit the prose before an incomplete call and keep the rest buffered. */
  private holdAndEmit(out: ScanEvent[], at: number): ScanEvent[] {
    if (at > 0) {
      out.push({ kind: "text", text: this.buf.slice(0, at) });
      this.buf = this.buf.slice(at);
    }
    return out;
  }

  /**
   * Handle the outcome of a (fresh or resumed) `continueJsonScan` call. `at` is the marker's
   * current offset into `this.buf` (0 whenever resuming, since the buffer is always anchored
   * to the marker's start while `pending` is set).
   */
  private handleJsonScanResult(
    r: JsonScanResume,
    ctx: { marker: Marker; dialect: CallDialect; cursor: number; fallbackName: string | undefined },
    at: number,
    final: boolean,
    out: ScanEvent[],
  ): "held" | "done" {
    const { marker, dialect, cursor, fallbackName } = ctx;
    if (!r.ok && r.why === "incomplete") {
      if (!final) {
        if (at > 0) {
          out.push({ kind: "text", text: this.buf.slice(0, at) });
          this.buf = this.buf.slice(at);
        }
        this.pending = {
          phase: "json",
          marker,
          dialect,
          cursor: cursor - at,
          fallbackName,
          progress: { ...r.progress, pos: r.progress.pos - at },
        };
        return "held";
      }
      out.push({
        kind: "malformed",
        error: {
          raw: this.buf.slice(at),
          dialect: marker.dialect,
          reason: "the call was cut off before it finished",
        },
      });
      this.buf = "";
      this.pending = null;
      return "done";
    }
    if (!r.ok) {
      // A marker with no JSON after it at all — the model wrote the tag and then prose.
      out.push({ kind: "text", text: this.buf.slice(0, at + marker.open.length) });
      this.buf = this.buf.slice(at + marker.open.length);
      this.pending = null;
      return "done";
    }
    return this.settleJsonEnd({ marker, dialect, cursor, fallbackName }, r.end, at, final, out);
  }

  /**
   * The JSON balances (fresh or resumed) — decide whether the closing tag might still be in
   * flight, or finalize the call now.
   */
  private settleJsonEnd(
    ctx: { marker: Marker; dialect: CallDialect; cursor: number; fallbackName: string | undefined },
    end: number,
    at: number,
    final: boolean,
    out: ScanEvent[],
  ): "held" | "done" {
    const { marker, dialect, cursor, fallbackName } = ctx;
    const base = marker.open.slice(1);

    // The JSON balances — but the CLOSING tag may still be in flight. Emitting now would
    // publish the call and then emit `</tool_call>` as prose one delta later, which is
    // exactly what a char-at-a-time stream produces. Wait until we can tell.
    const expectedCloser = marker.close ?? (marker.family ? `</${base}>` : undefined);
    if (expectedCloser && !final) {
      const trimmed = this.buf.slice(end).trimStart();
      const couldBeClose =
        trimmed.length === 0 ||
        // `</tool_call1>` is longer than `</tool_call>`, so a plain prefix test would stop
        // waiting one byte early on a numbered tag.
        (trimmed.length <= expectedCloser.length + 4 &&
          expectedCloser.slice(0, trimmed.length).startsWith(trimmed.replace(/\d+>?$/, "")) &&
          closerLength(this.buf, end, base) === 0);
      if (couldBeClose) {
        if (at > 0) {
          out.push({ kind: "text", text: this.buf.slice(0, at) });
          this.buf = this.buf.slice(at);
        }
        this.pending = {
          phase: "closer",
          marker,
          dialect,
          cursor: cursor - at,
          fallbackName,
          end: end - at,
        };
        return "held";
      }
    }

    if (at > 0) out.push({ kind: "text", text: this.buf.slice(0, at) });
    const json = this.buf.slice(cursor, end);
    let after = end;
    // Consume the closing tag when the model bothered to write one, number and all.
    if (marker.family) {
      after += closerLength(this.buf, after, base);
    } else if (marker.close) {
      const rest = this.buf.slice(after);
      const lead = rest.length - rest.trimStart().length;
      if (rest.trimStart().startsWith(marker.close)) after += lead + marker.close.length;
    }
    out.push(...decodePayload(json, dialect, this.buf.slice(at, after), fallbackName));
    this.buf = this.buf.slice(after);
    this.pending = null;
    return "done";
  }
}

/* ── one-shot ────────────────────────────────────────────────────────────────*/

/** The whole-message form: scan `text` and return every event. */
export function scanToolCalls(text: string): ScanEvent[] {
  const scanner = new ToolCallScanner();
  return [...scanner.push(text), ...scanner.end()];
}

/** Just the calls, for callers that do not care about the prose. */
export function parseToolCalls(text: string): TextToolCall[] {
  return scanToolCalls(text).flatMap((e) => (e.kind === "call" ? [e.call] : []));
}

/** Whether `text` contains at least one readable call — the degrade signal (see negotiate). */
export function hasTextToolCall(text: string): boolean {
  return scanToolCalls(text).some((e) => e.kind === "call");
}
