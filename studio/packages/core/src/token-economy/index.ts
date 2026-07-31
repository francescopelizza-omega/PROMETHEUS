/**
 * token-economy — the curated token-saving toolkit Prometheus proposes by default
 * (terse output / prompt caching / repo map / local RAG / context pruning / …) +
 * the honest Gemini-Nano local-feasibility assessment.
 */
export {
  TOKEN_TOOLS,
  getTokenTool,
  tokenWiring,
  type TokenTool,
  type TokenCategory,
  type Saves,
  type BestFor,
  type Maturity,
} from "./techniques.js";
export {
  proposeToolkits,
  proposeHeadline,
  type ProposeOptions,
} from "./propose.js";
export {
  GEMINI_NANO,
  type NanoAssessment,
  type NanoMethod,
  type NanoFeasibility,
  type NanoReliability,
} from "./nano.js";
export {
  walkRepo,
  renderRepoMap,
  extractSymbols,
  estimateTokens,
  parseGitignore,
  isGitIgnored,
  DEFAULT_IGNORE_DIRS,
  type RepoFs,
  type RepoDirent,
  type RepoEntry,
  type RepoMap,
  type WalkOptions,
} from "./repo-map.js";
