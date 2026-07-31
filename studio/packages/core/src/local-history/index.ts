/**
 * local-history — file 13 §2.6: a git-independent, capped file-snapshot timeline with
 * diff + revert (survives uncommitted work). Pure ring buffer + capture policy +
 * line-delta + serialize; persistence to `.prometheus/history/` is the caller's.
 */
export type { RingBuffer } from "./ringBuffer.js";
export { clear, createRingBuffer, entries, isFull, push, recent, size } from "./ringBuffer.js";
export type { CapturePolicy, FileSnapshot, LineDelta, LocalHistory } from "./history.js";
export {
  DEFAULT_HISTORY_CAP,
  createLocalHistory,
  deserializeHistory,
  latestFor,
  lineDelta,
  recordSnapshot,
  revertContent,
  serializeHistory,
  shouldCapture,
  snapshotsFor,
} from "./history.js";
