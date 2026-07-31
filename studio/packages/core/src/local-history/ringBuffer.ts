/**
 * local-history/ringBuffer.ts — a pure capped FIFO ring buffer (file 13 §2.6).
 *
 * The substrate for Local History (a git-independent file-snapshot timeline). PURE +
 * in-memory: persistence (writing `.prometheus/history/`) is the caller's job (the
 * desktop main / CLI), so this stays testable + Node-built-in-free. Pushing past
 * capacity drops the oldest entry — bounded disk by construction (§2.6 retention).
 */

/** A bounded FIFO ring buffer (immutable ops). */
export interface RingBuffer<T> {
  capacity: number;
  items: readonly T[]; // oldest → newest
}

/** Create an empty ring buffer with a fixed capacity (>=1). */
export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  return { capacity: Math.max(1, Math.floor(capacity)), items: [] };
}

/** Push an item; drops the oldest when over capacity. Returns a NEW buffer. */
export function push<T>(buf: RingBuffer<T>, item: T): RingBuffer<T> {
  const next = [...buf.items, item];
  const trimmed = next.length > buf.capacity ? next.slice(next.length - buf.capacity) : next;
  return { capacity: buf.capacity, items: trimmed };
}

/** All entries, oldest → newest. */
export function entries<T>(buf: RingBuffer<T>): T[] {
  return [...buf.items];
}

/** Entries newest → oldest (the timeline order Local History renders). */
export function recent<T>(buf: RingBuffer<T>): T[] {
  return [...buf.items].reverse();
}

export function size<T>(buf: RingBuffer<T>): number {
  return buf.items.length;
}

export function isFull<T>(buf: RingBuffer<T>): boolean {
  return buf.items.length >= buf.capacity;
}

/** Drop everything (returns a NEW empty buffer of the same capacity). */
export function clear<T>(buf: RingBuffer<T>): RingBuffer<T> {
  return { capacity: buf.capacity, items: [] };
}
