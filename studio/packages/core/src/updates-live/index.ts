// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates-live/index.ts — the update checker's IO half, shared by every surface.
 *
 * ── WHY THIS IS A SEPARATE BARREL FROM `updates/` ───────────────────────────────────────────
 *
 * `packages/core/src/updates/` is PURE — tables, parsers and decisions, with `node:crypto` as
 * its only builtin — and `packages/core/src/index.ts` re-exports it as `updates`, which reaches
 * the SANDBOXED RENDERER. Dropping `node:fs`, `node:child_process` and `fetch` into that barrel
 * would pull process-spawning code into a bundle that must not have it, and the desktop's vite
 * build would either fail or, worse, shim it away silently (the CORE_SUBPATHS alias trap this
 * repo already recorded once).
 *
 * So the IO lives here, behind its own `@prometheus/core/updates-live` export. Only a main
 * process or a CLI may import it.
 *
 * ── WHY IT IS IN CORE AT ALL ────────────────────────────────────────────────────────────────
 *
 * It was in `apps/cli`, where the desktop could not reach it — so Studio had NO update surface
 * beyond Electron's own auto-updater, and a Studio-only user could never learn that their
 * `claude`, `codex`, `ollama` or local models were out of date. CLAUDE.md §1 is explicit that
 * shared behaviour lives once in core and is used by every surface; this was a counter-example.
 *
 * The alternative — a second implementation in the desktop main process — would have recreated
 * the exact defect this work exists to remove: two PATH resolvers that disagree about the same
 * machine.
 */

export type { ProbeDeps, FetchLike, HeadProbe } from "./model-check.js";
export {
  PROBE_TIMEOUT_MS,
  PROBE_CONCURRENCY,
  headManifest,
  fetchBuild,
  checkModelUpdates,
  fetchOllamaVersion,
} from "./model-check.js";

export { fetchNpmLatest, fetchGithubLatest, fetchOllamaTags } from "./fetch.js";

export type { ChannelAnswer, FetchDeps } from "./channel-fetch.js";
export {
  channelLabel,
  askChannel,
  askLatest,
  fetchGitlabLatest,
  fetchGitlabRelease,
} from "./channel-fetch.js";

export { which, cliVersion, detectInstallMethod, engineVersion } from "./probe.js";

export type { ResolveDeps } from "./resolve.js";
export {
  readAppBundleVersion,
  resolveCopies,
  resolveToolCheck,
  npmGlobalBinDir,
  onSearchPath,
  readJsonFile,
} from "./resolve.js";

export type { SweepDeps, ManagerSweep } from "./package-sweep.js";
export {
  SWEEP_TIMEOUT_MS,
  availableManagers,
  sweepManager,
  sweepPackages,
  upgradeLineFor,
} from "./package-sweep.js";

export type { ToolSweepDeps } from "./tool-sweep.js";
export { TOOL_CONCURRENCY, sweepTools, legacyCliRows } from "./tool-sweep.js";

/**
 * MODEL OPERATIONS — pull, remove, and the local facts no HTTP endpoint exposes.
 *
 * Local-only by construction: `assertLocal` refuses any non-loopback daemon, mirroring the
 * refusal `ai-ipc.ts` already applies to endpoint probing. A pull sends no credentials but a
 * remove destroys data, and neither belongs pointed at a host the user did not configure.
 */
export type { OpsDeps, PullResult } from "./model-ops.js";
export {
  DEFAULT_OLLAMA_URL,
  pullModel,
  removeModel,
  loadedModels,
  ollamaModelsDir,
  readLocalManifest,
  localManifestPath,
  readAllLocalManifests,
} from "./model-ops.js";

/** Filling the catalogue: HuggingFace search + per-quantisation sizes. */
export type {
  RateLimit,
  CatalogFetchDeps,
  CatalogFetchResult,
  HfSearchOpts,
  Quantization,
  RepoFormats,
} from "./catalog-fetch.js";
export {
  HF_API,
  parseRateLimit,
  licenseFromTags,
  classifyLicense,
  entryFromHf,
  searchHuggingFace,
  fetchQuantizations,
  quantLabel,
  estimateQ4Bytes,
  Q4_K_M_BYTES_PER_PARAM,
  detectRepoFormats,
} from "./catalog-fetch.js";

/**
 * REMEDY FACTS — the filesystem half of `updates/remedies.ts`.
 *
 * Which init file the user's shell actually reads, and whether writing to it is safe at all.
 */
export type { ShellInitTarget, ShellInitDeps } from "./remedies-live.js";
export { pathBlock, shellInitFor } from "./remedies-live.js";

export type { CheckDeps, CheckResult } from "./check.js";
export { checkUpdates } from "./check.js";
