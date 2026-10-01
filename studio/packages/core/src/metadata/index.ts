// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * metadata — the shared rules for presenting a file's metadata (file 0C).
 *
 * Pure. No IO: the sidecar produces the payload, the hosts render it, and this decides which
 * keys deserve a privacy flag so the CLI and the desktop panel cannot disagree.
 */
export { SENSITIVE_METADATA_KEYS, isSensitiveMetadataKey } from "./sensitive.js";
