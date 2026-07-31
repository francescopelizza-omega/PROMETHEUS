/**
 * rules — file 14 §3.3: AGENTS.md/CLAUDE.md precedence chain + /init scaffold. Pure;
 * the caller reads files + gates remote instruction fetches (C12).
 */
export type {
  AssembledRules,
  InitScaffoldInput,
  RuleKind,
  RuleScope,
  RuleSource,
} from "./loader.js";
export {
  DEFAULT_PRECEDENCE,
  assembleRules,
  initRulesScaffold,
  isRemoteInstruction,
  orderRuleSources,
} from "./loader.js";
