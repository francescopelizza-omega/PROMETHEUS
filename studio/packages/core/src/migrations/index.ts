// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * migrations — versioned state migration runner (Reliability & Polish pack). Evolve
 * persisted settings/sessions/themes across releases idempotently + fail-soft. Pure.
 */
export type { Migration, MigrationResult, Versioned } from "./migrations.js";
export { latestVersion, runMigrations, stateVersion, validateMigrations } from "./migrations.js";
