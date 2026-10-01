// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/grants-store.ts — a pointer, not a store.
 *
 * The implementation moved into core's host half so the DESKTOP writes and reads the SAME
 * `<config>/grants.json`. A grant is a security decision the user makes once; having each
 * surface keep its own would mean answering "always" twice for the same tool and reasonably
 * concluding the answer had not been recorded.
 */
export {
  grantsPath,
  loadGrantsInto,
  readGrants,
  saveGrants,
} from "@prometheus/core/agent-system-host";
