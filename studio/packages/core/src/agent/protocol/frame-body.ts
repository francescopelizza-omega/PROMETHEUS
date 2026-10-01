// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/protocol/frame-body.ts — neutralize frame delimiters inside untrusted CONTENT.
 *
 * Every untrusted-data frame in this repo sanitizes the ATTRIBUTE it interpolates — the source
 * URL, the server and tool names — and then puts the body in raw. The module docs are explicit
 * that the frame is the protection: "the characters that could break OUT of that frame are
 * stripped from the source URL — otherwise the page could forge its own delimiter and present
 * itself to the model as trusted context." The body is exactly where a hostile page would forge
 * the delimiter, and it was the one place nothing touched.
 *
 * So a fetched page, an MCP result, or a repo file containing the literal line
 * `<<end untrusted-web-data>>` terminated the frame early, and everything after it read to the
 * model as ordinary first-party context — including whatever instructions followed. The
 * injection scanner is not a backstop for this: its own header says "the frame is the real
 * protection; this is what lets a caller ALSO say 'and this one looks suspicious'", and none of
 * its patterns match a delimiter or the ordinary-sounding prose that follows one.
 *
 * Defanging inserts a space into the bracket pair rather than deleting anything, so the text a
 * human reads is unchanged in meaning and nothing is silently lost — but the sequence can no
 * longer close or open a frame.
 */

/** Any frame marker: `<<untrusted-…-data …>>` or `<<end untrusted-…-data>>`. */
const FRAME_MARKER = /<<(\s*(?:end\s+)?untrusted-[\w-]*-data\b[^>]*)>>/gi;

/**
 * Make `body` unable to open or close an untrusted-data frame.
 *
 * Applied to the CONTENT of every frame, by the code that builds the frame — never left to the
 * caller, because a caller that has to remember is a caller that will forget.
 */
export function defangFrameMarkers(body: string): string {
  return body.replace(FRAME_MARKER, (_m, inner: string) => `< <${inner}> >`);
}

/**
 * Does `text` already carry a frame marker? Used by the sub-agent fallback to avoid double
 * wrapping a report that a nested tool already framed.
 *
 * Matches the marker with or without attributes. The previous expression required whitespace or
 * a quote right after `-data`, so it did not match `<<untrusted-subagent-data>>` — the very
 * marker written a few lines below it, whose comment claimed it was "named `-data`, not
 * `-report`, so it matches its OWN fallback regex above".
 */
export function hasFrameMarker(text: string): boolean {
  return /<<\s*(?:end\s+)?untrusted-[\w-]*-data\b/i.test(text);
}
