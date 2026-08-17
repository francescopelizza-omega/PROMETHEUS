/**
 * agent/bytes.ts — UTF-8 byte helpers that work in the SANDBOXED renderer.
 *
 * `Buffer` is a Node global. The desktop renderer runs with `sandbox: true` +
 * `nodeIntegration: false`, where `typeof Buffer === "undefined"` — verified by probing
 * the running app, not assumed. Any `agent/*` module that touched Buffer therefore threw
 * a `ReferenceError` the moment the GUI imported it; `shouldSnapshot` did exactly that,
 * and because the throw was swallowed by the caller's try/catch the GUI's per-turn revert
 * silently never worked.
 *
 * TextEncoder/TextDecoder are WHATWG globals — present in Node ≥11 AND in every browser
 * context — so these are the portable equivalents. `decode()` on a split multi-byte
 * sequence yields U+FFFD, exactly as `Buffer#toString("utf8")` did.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder(); // fatal:false ⇒ a split sequence becomes U+FFFD

/** UTF-8 byte length of `s` (the `Buffer.byteLength(s, "utf8")` replacement). */
export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

/** UTF-8 bytes of `s`. */
export function utf8Bytes(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Decode UTF-8 `bytes` back to a string (a split sequence degrades to U+FFFD). */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
