// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * health — system-health aggregation (Reliability & Polish pack). Fold component
 * statuses into a SystemHealth (tier + 0–100 score + remediation). Pure + fail-closed.
 */
export type { ComponentStatus, HealthComponent, HealthTier, SystemHealth } from "./health.js";
export {
  aggregateHealth,
  boolComponent,
  breakerStatus,
  engineComponent,
  serveComponent,
  threatDbComponent,
} from "./health.js";
