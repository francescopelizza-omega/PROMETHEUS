// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * memory — the agent's durable cross-session fact store: parse/validate/assemble (PURE).
 * The host reads/writes `~/.prometheus/memory/<project-key>/*.md`
 * (agent/system/host/memory-store.ts) and the tool defs live in agent/system/memory.ts.
 */
export type {
  MemoryEntry,
  MemoryIndexItem,
  MemoryMeta,
  MemoryWriteInput,
  MemoryWriteResult,
  ParsedMemoryFile,
} from "./loader.js";
export {
  MAX_BODY_CHARS,
  MAX_CATEGORY_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  MAX_WHY_CHARS,
  MEMORY_INDEX_FILE,
  entryFromParsed,
  memoryIndexBlock,
  parseMemoryFile,
  renderMemoryIndex,
  serializeMemoryEntry,
  slugify,
  validateMemoryWrite,
} from "./loader.js";
