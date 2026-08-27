/**
 * metadata/sensitive.ts — which metadata keys commonly leak personal, location or device info.
 *
 * Lives in core because BOTH surfaces that show a file's metadata need the same answer, and they
 * had already diverged: the desktop panel flagged sensitive rows while the CLI's
 * `metadata inspect` showed no tags at all (it printed `tags: [object Object]`), so the two
 * surfaces disagreed about what the user was even looking at. This is the privacy surface — the
 * screen someone reads before deciding whether to scrub a file — so one shared list is the point.
 */

/** Substrings that mark a metadata key as privacy-relevant (matched case-insensitively). */
export const SENSITIVE_METADATA_KEYS: readonly string[] = [
  "gps",
  "latitude",
  "longitude",
  "location",
  "geo",
  "author",
  "creator",
  "owner",
  "artist",
  "copyright",
  "byline",
  "serial",
  "device",
  "make",
  "model",
  "software",
  "lens",
  "email",
  "user",
  "host",
  "comment",
  "history",
  "documentid",
  "instanceid",
  "producer",
];

/** Whether a metadata key commonly leaks personal / location / device info. */
export function isSensitiveMetadataKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_METADATA_KEYS.some((s) => k.includes(s));
}
