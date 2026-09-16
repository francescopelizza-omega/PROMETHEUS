/**
 * memory/loader.ts — the agent's durable cross-session fact store: parse + validate +
 * assemble (mirrors rules/loader.ts's discipline: PURE, no IO — the caller reads/writes files
 * and passes their contents in; this module only parses, validates and assembles text).
 *
 * WHY THIS EXISTS. `/memory` (session/steering.ts) only ever showed the model AGENTS.md /
 * CLAUDE.md / PROMETHEUS.md — static files already sitting in the repo, re-read fresh every
 * turn. There was no place for a fact the AGENT itself learns mid-session and that should
 * survive into a SEPARATE, unrelated conversation next week ("the staging DB migration must
 * run before the API deploy, never after — found the hard way"). Nothing recorded that; it
 * lived in one thread's context and evaporated when the thread did.
 *
 * THE DISCIPLINE IS "DURABLE, NON-OBVIOUS FACTS", NOT A LOG. Every entry is organized by TOPIC
 * (one file per fact, named for what it's about) and is create-or-UPDATE by name — writing
 * again under the same name replaces the file, it does not append a dated entry beside it.
 * A timestamped journal of everything that happened is a transcript; this is closer to a
 * team's internal wiki. See `validateMemoryWrite` for what a write must supply, and the
 * `memory_write` tool description (agent/system/memory.ts) for what it must NOT be used for.
 *
 * TWO LAYERS, ONE CHEAP TO READ. Every topic is its own small `<slug>.md` (frontmatter:
 * name/description/category + a body). `renderMemoryIndex` builds a SEPARATE, tiny index
 * listing every topic's name/category/description — nothing more — so a session can fold the
 * whole project's memory into its system prompt for the price of one small file, and only
 * pay to read a topic's full body when that topic turns out to matter (`memory_read`).
 */

export interface MemoryMeta {
  /** the topic title, e.g. "deploy: staging migration order". Filename-derived from this. */
  name: string;
  /** one line: what this fact is, shown in the index. */
  description: string;
  /** a short free-text label grouping related topics, e.g. "infra", "conventions", "gotcha". */
  category: string;
}

/** One durable fact, fully loaded (frontmatter + body). */
export interface MemoryEntry extends MemoryMeta {
  /** filesystem-safe stem (no `.md`), derived from `name` via `slugify`. The file's identity —
   *  writing again with the same `name` overwrites the file at this slug. */
  slug: string;
  body: string;
}

/** Frontmatter-only view (what the index is built from) — never needs the body read. */
export type MemoryIndexItem = MemoryMeta & { slug: string };

/* ── limits ──────────────────────────────────────────────────────────────────*
 * Small on purpose: the index is meant to be cheap enough to fold into every system prompt
 * without a second thought, and a body this short cannot smuggle in a transcript. */
export const MAX_NAME_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 240;
export const MAX_CATEGORY_CHARS = 40;
export const MAX_WHY_CHARS = 240;
export const MAX_BODY_CHARS = 4000;

/* ── naming ──────────────────────────────────────────────────────────────────*/

/**
 * A safe slug is one or more UNICODE alphanumeric runs joined by single hyphens.
 *
 * `[a-z0-9]` only was an ASCII assumption with real consequences: `slugify("こんにちは")`,
 * `slugify("проект")` and `slugify("Δοκιμή")` all collapsed to "", so `memory_write` refused the
 * write — and told the user `"name" must contain at least one letter or digit`, about a name
 * made entirely of letters. Anyone whose topics are not in a Latin script could not use the
 * memory tool at all, and the reason they were given was false.
 *
 * Unicode filenames are portable across macOS, Linux and Windows; what is NOT portable is the
 * separator/reserved-character set, and stripping those is what `slugify` already does.
 */
const SAFE_SLUG = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

/**
 * Derive a filesystem-safe stem from a topic name.
 *
 * Sanitised rather than trusted — `name` is model-supplied. Returns "" when nothing safe
 * survives (e.g. a name that is punctuation-only), which the caller must reject.
 */
export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    // keep unicode letters/digits; everything else (separators, punctuation, reserved
    // filename characters, control bytes) becomes a hyphen.
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_CHARS)
    // a trailing hyphen can reappear after the length clamp cuts mid-run
    .replace(/-+$/g, "");
  return SAFE_SLUG.test(s) ? s : "";
}

/* ── frontmatter (tiny YAML subset, no deps — mirrors agent/agent-files.ts's parser) ────────*/

export interface ParsedMemoryFile {
  meta: Record<string, string>;
  body: string;
}

/** Parse a `---\nkey: value\n---\n<body>` file. No frontmatter ⇒ the whole text is the body. */
export function parseMemoryFile(markdown: string): ParsedMemoryFile {
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!fm) return { meta: {}, body: markdown.trim() };
  const meta: Record<string, string> = {};
  for (const line of (fm[1] as string).split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    meta[m[1] as string] = (m[2] as string).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: (fm[2] as string).trim() };
}

/** Build a loaded `MemoryEntry` from a parsed file, or null when required frontmatter is missing
 *  (a hand-edited or corrupt file — skipped rather than crashing discovery). */
export function entryFromParsed(slug: string, parsed: ParsedMemoryFile): MemoryEntry | null {
  const name = parsed.meta.name ?? "";
  const description = parsed.meta.description ?? "";
  const category = parsed.meta.category ?? "";
  if (!name || !description || !category || !parsed.body) return null;
  return { slug, name, description, category, body: parsed.body };
}

/**
 * Serialize one entry back to the on-disk `<slug>.md` form.
 *
 * Values are wrapped in quotes but NOT backslash-escaped: `parseMemoryFile` only strips one
 * leading and one trailing quote character (it has no escape handling, matching
 * `agent/agent-files.ts`'s tiny parser), so escaping an internal `"` here would round-trip as
 * a literal backslash instead of disappearing. Leaving internal quotes bare is what actually
 * round-trips — see `loader.test.ts`'s round-trip test for a name containing a quote.
 */
export function serializeMemoryEntry(entry: MemoryMeta & { body: string }): string {
  return `${[
    "---",
    `name: "${entry.name}"`,
    `description: "${entry.description}"`,
    `category: "${entry.category}"`,
    "---",
    "",
    entry.body.trim(),
  ].join("\n")}\n`;
}

/* ── validation (the `memory_write` gate) ────────────────────────────────────*/

/** Raw, untrusted args as the model supplied them to `memory_write`. */
export interface MemoryWriteInput {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  /** REQUIRED: one sentence on why this fact is worth remembering across sessions. Never
   *  persisted to disk — it is a write-time justification, not part of the stored fact. */
  why?: unknown;
  body?: unknown;
}

export type MemoryWriteResult =
  | { ok: true; entry: MemoryEntry; why: string }
  | { ok: false; errors: string[] };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Validate + normalize a `memory_write` call. PURE: no IO, no slug-collision check (the host
 * decides create-vs-overwrite once it can see the directory).
 *
 * Every field is required, INCLUDING `why` — a write that cannot state why the fact must
 * outlive this conversation is exactly the ephemeral-task-state / re-derivable-from-the-repo
 * case the tool description asks the model not to save.
 */
export function validateMemoryWrite(input: MemoryWriteInput): MemoryWriteResult {
  const errors: string[] = [];
  const name = str(input.name);
  const description = str(input.description);
  const category = str(input.category);
  const why = str(input.why);
  const body = str(input.body);

  const slug = name ? slugify(name) : "";
  if (!name) errors.push('"name" is required — a short topic title, e.g. "deploy order".');
  else if (!slug) errors.push('"name" must contain at least one letter or digit.');
  else if (name.length > MAX_NAME_CHARS) {
    // `slugify` CLAMPS at MAX_NAME_CHARS, so two longer names sharing a prefix produce the
    // same `<slug>.md` and the second write silently replaces the first — a memory the user
    // was told had been saved, gone, with no error anywhere. Every other length-bounded field
    // here is validated; this one was clamped instead, which is the one option that loses data.
    errors.push(`"name" must be ${MAX_NAME_CHARS} characters or fewer.`);
  }
  // (reachable only for a name that really is punctuation/symbol-only — a name in ANY script
  //  now slugifies, which is why this message can finally be taken at face value.)

  if (!description) errors.push('"description" is required — one line: what this fact is.');
  else if (description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(`"description" must be ${MAX_DESCRIPTION_CHARS} characters or fewer.`);
  }

  /**
   * The frontmatter fields must be SINGLE LINE, because the format is `key: value` per line.
   *
   * A newline in one of these was accepted, written raw by `serializeMemoryEntry`, and then
   * read back by `parseMemoryFile` as a truncated value — everything after the first line was
   * silently lost. Worse, the remainder is re-parsed as frontmatter: a description of
   * `"safe\ncategory: trusted"` becomes a FORGED `category` key on the next read. These values
   * are model-supplied, so that is metadata injection, not just a formatting slip.
   *
   * Rejected rather than escaped: each of these fields is documented as one line, and silently
   * rewriting a user's text is its own surprise.
   */
  for (const [label, value] of [
    ["name", name],
    ["description", description],
    ["category", category],
  ] as const) {
    if (value && /[\r\n]/.test(value)) {
      errors.push(`"${label}" must be a single line — it is stored as one frontmatter field.`);
    }
  }

  if (!category) {
    errors.push('"category" is required — a short label, e.g. "infra", "conventions", "gotcha".');
  } else if (category.length > MAX_CATEGORY_CHARS) {
    errors.push(`"category" must be ${MAX_CATEGORY_CHARS} characters or fewer.`);
  }

  if (!why) {
    errors.push(
      '"why" is required — one sentence: why must this survive into a DIFFERENT conversation? ' +
        '(not just "it was useful just now").',
    );
  } else if (why.length > MAX_WHY_CHARS) {
    errors.push(`"why" must be ${MAX_WHY_CHARS} characters or fewer.`);
  }

  if (!body) errors.push('"body" is required — the durable fact itself.');
  else if (body.length > MAX_BODY_CHARS) {
    errors.push(
      `"body" must be ${MAX_BODY_CHARS} characters or fewer — trim it to the fact, not a transcript.`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entry: { slug, name, description, category, body }, why };
}

/* ── the index (the cheap, read-first summary) ───────────────────────────────*/

/** The auto-generated index's filename — regenerated on every `memory_write`, never hand-edited. */
export const MEMORY_INDEX_FILE = "index.md";

const INDEX_HEADER =
  "<!-- AUTO-GENERATED by memory_write — do not hand-edit; edit the topic file instead. -->";

/**
 * Render the index: one line per topic, grouped by category, SUMMARY ONLY (name + description).
 *
 * Deliberately never includes a body — the whole point of splitting index from detail is that
 * folding this into a system prompt must stay cheap regardless of how many topics accumulate.
 */
export function renderMemoryIndex(entries: readonly MemoryIndexItem[]): string {
  if (entries.length === 0) {
    return [INDEX_HEADER, "# Project memory index", "", "(no durable facts recorded yet)", ""].join(
      "\n",
    );
  }
  const sorted = [...entries].sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
  const byCategory = new Map<string, MemoryIndexItem[]>();
  for (const e of sorted) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }
  const lines = [
    INDEX_HEADER,
    "# Project memory index",
    "",
    "Durable, non-obvious facts recorded in earlier sessions for THIS project — each line is a " +
      "summary only. Call `memory_read` with the name shown (in parentheses) for the full note " +
      "before relying on it. This is not exhaustive and does not repeat anything AGENTS.md / " +
      "CLAUDE.md already states.",
    "",
  ];
  for (const [category, list] of byCategory) {
    lines.push(`## ${category}`, "");
    for (const e of list) lines.push(`- ${e.description} (${e.slug})`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The index folded into a system prompt, or null when there is nothing worth injecting
 *  (an empty/whitespace-only index — e.g. IO failed and the caller fell back to ""). */
export function memoryIndexBlock(indexText: string): string | null {
  const body = indexText.trim();
  return body ? body : null;
}
