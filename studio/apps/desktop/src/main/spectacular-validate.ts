/**
 * main/spectacular-validate.ts — argv option-injection guard for the SPECTACULAR seam.
 *
 * The renderer is sandboxed, but a compromised renderer must not be able to smuggle
 * a leading-dash value (e.g. `--help`, `-x`, `--set-root`) through the IPC boundary
 * into the engine's argparse surface, where it would be parsed as a FLAG instead of
 * data. These pure validators run on the trusted (main) side before any value
 * reaches the engine-bridge argv builders. Identifier-like args are charset-pinned
 * and must never start with `-`; free-form prompts are guarded with a `--`
 * end-of-options separator in commands.ts instead (they may legitimately lead with
 * `-`). Mirrors the leading-dash defense used by the catalog/metadata seams.
 */

/** True for NUL + any C0/C1 control char (newline, CR, tab, ESC, DEL, …) — these
 *  could split or smuggle an argument and never appear in a real id/path. */
function hasControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** True when a token is safe to pass as a positional/option-value (no leading dash,
 *  no control chars / newlines / NUL that could split or smuggle arguments). */
export function isSafeToken(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0) return false;
  if (v.length > 4096) return false; // unbounded values are never a real id/path
  if (v.startsWith("-")) return false; // would be parsed as an option flag
  if (hasControlChar(v)) return false;
  return true;
}

/** Charset-pinned catalog id: starts alnum, then word/.-+/@:/ chars only. Never a flag. */
export function cleanId(arg: unknown): string | undefined {
  const id =
    typeof arg === "string"
      ? arg
      : arg && typeof arg === "object" && typeof (arg as { id?: unknown }).id === "string"
        ? (arg as { id: string }).id
        : undefined;
  if (id === undefined) return undefined;
  if (!isSafeToken(id)) return undefined;
  return /^[A-Za-z0-9][\w.+/@:-]*$/.test(id) ? id : undefined;
}

/** A path-ish token (models root): no leading dash, no control chars. Returns
 *  undefined if unsafe so the caller can fail the request rather than inject. */
export function cleanPathToken(v: unknown): string | undefined {
  return isSafeToken(v) ? (v as string) : undefined;
}
