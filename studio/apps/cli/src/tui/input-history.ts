/**
 * tui/input-history.ts — persist the composer's ↑/↓ history across restarts (CLI-062).
 *
 * A JSONL file under the prometheus home (`~/.prometheus/input-history.jsonl`): one
 * `JSON.stringify(line)` per line so multi-line submissions round-trip. Mirrors history-store.ts's
 * fs posture — a missing / corrupt / read-only file yields EMPTY history and NEVER throws. Secret-
 * looking lines stay in the in-memory ring (usable via ↑) but are NEVER written to disk.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The history file path under the prometheus home. */
export function inputHistoryPath(home: string): string {
  return join(home, "input-history.jsonl");
}

const CAP = 1000;

/** Patterns that mark a line too secret to persist (stays in-memory, never on disk). */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/, // OpenAI-style keys
  /\b(?:ghp|gho|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /Bearer\s+\S{8,}/i, // bearer auth
  /-----BEGIN [A-Z ]+-----/, // PEM private keys
  /api[_-]?key\s*[=:]\s*\S+/i, // api_key= / api-key: assignments
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/, // long base64 blobs
  /\b[0-9a-fA-F]{40,}\b/, // long hex blobs (sha/keys)
];

/** Is a line secret-looking? Such lines are usable in-session but never written to disk. */
export function isSecretLike(line: string): boolean {
  return SECRET_PATTERNS.some((rx) => rx.test(line));
}

/**
 * Load persisted history (oldest→newest, the order the reducer's ↑ browses backward from). Skips
 * corrupt lines, truncates an oversized legacy file to the newest CAP. Never throws.
 */
export function loadInputHistory(file: string, cap = CAP): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return []; // ENOENT / EACCES / EROFS → no history
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line);
      if (typeof v === "string" && v !== "") out.push(v);
    } catch {
      /* skip one corrupt line — never fail the whole load */
    }
  }
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/**
 * Append one submitted line: skips empty + secret-looking lines, dedupes against the newest stored
 * entry (adjacent dedupe), enforces the CAP by dropping the oldest, and rewrites the file. Never
 * throws — a read-only home just means nothing is persisted.
 */
export function appendInputHistory(file: string, line: string, cap = CAP): void {
  const trimmed = line.trim();
  if (trimmed === "" || isSecretLike(trimmed)) return; // never persist secrets/empty
  try {
    const existing = loadInputHistory(file, cap);
    if (existing[existing.length - 1] === trimmed) return; // adjacent dedupe on disk
    existing.push(trimmed);
    const capped = existing.length > cap ? existing.slice(existing.length - cap) : existing;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${capped.map((l) => JSON.stringify(l)).join("\n")}\n`);
  } catch {
    /* read-only / EROFS → skip persistence, never throw (mirrors history-store.ts) */
  }
}
