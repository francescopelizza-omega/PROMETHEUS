// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * hooks/ barrel (08 §3 tree). The React hooks @prometheus/ui publishes for both
 * the desktop renderer and the CLI web-help/onboarding view: useTheme/useDensity
 * (§6 theming), useStreamLog (§3.2 JSON-lines tail), useEngine (bridge query).
 * All renderer-sandbox-safe (react + @prometheus/ui only; no node/electron).
 */

export { useTheme } from "./useTheme.js";
export type { UseThemeResult } from "./useTheme.js";
export { useDensity } from "./useDensity.js";
export { useStreamLog } from "./useStreamLog.js";
export type { UseStreamLogResult } from "./useStreamLog.js";
export { useEngine } from "./useEngine.js";
export type { UseEngineState } from "./useEngine.js";
