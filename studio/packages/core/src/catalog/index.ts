/**
 * catalog/index.ts — the @prometheus/core catalog surface (file 06 §2, §7).
 *
 * The framework-free projection + reconciliation + cache layer the catalog browser (desktop)
 * and `prometheus` CLI both render. It depends ONLY on @prometheus/engine-bridge (for the C3
 * verdict ref) and Node-free pure logic. NOTHING here decides "safe" (C5): it shapes the
 * engine's catalog reads + stores the engine's SIGNED verdict refs.
 */

// --- types (file 06 §2 shapes) --------------------------------------------- //
export type {
  CatalogTier,
  CatalogKind,
  CatalogScope,
  ReachCell,
  CatalogComponent,
  CatalogItem,
  PerAgentState,
  InstallState,
  InstallPresence,
  InstallTarget,
  RepoStatus,
  CatalogRepo,
  Repo as CatalogRepoAlias,
  NemesisVerdictRef,
} from "./types.js";

// --- normalize: engine JSON -> CatalogItem[] (pure) ------------------------ //
export type {
  EngineListRow,
  EngineInfoPlugin,
  DocumentedEntry,
  MatrixReachRow,
  WhereTargetRow,
  AppTableOptions,
} from "./normalize.js";
export {
  listRowToItem,
  listToItems,
  infoComponents,
  infoToItem,
  mergeInfo,
  reachRowToMap,
  reachIndex,
  applyReach,
  whereTargets,
  documentedToItem,
  documentedToItems,
  appTableToItems,
  sortCatalog,
  buildPluginCatalog,
} from "./normalize.js";

// --- reconcile: status/inventory -> InstallState (pure) -------------------- //
export type { StatusPluginBlock, StatusEnvelopeLike, OptimisticOp } from "./reconcile.js";
export {
  statusToInstallState,
  presenceOf,
  indexStatus,
  mergeState,
  reconcileItems,
  applyOptimistic,
  bindVerdict,
} from "./reconcile.js";

// --- cache: registry (version+mtime) + volatile (TTL) ---------------------- //
export type { EngineSignature, CatalogCacheOptions } from "./cache.js";
export {
  CatalogCache,
  createCatalogCache,
  sameSignature,
  DEFAULT_VOLATILE_TTL_MS,
} from "./cache.js";

// --- repos: sidecar index projection + verdict-ref store (pure) ------------ //
export type { SidecarRepoRow } from "./repos.js";
export {
  toVerdictRef as repoVerdictRef,
  verdictCommit,
  toCatalogRepo,
  toCatalogRepos,
  isBlockedRepo,
  isCleanRepo,
  needsConfirmRepo,
  reposByCatalogItem,
  linkReposToItems,
  sortReposByFetched,
} from "./repos.js";
