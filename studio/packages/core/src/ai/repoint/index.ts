/**
 * ai/repoint — the localai "run it free locally" escape hatch (file 12 §6).
 * Repoint a metered open-weight connector to a $0 local serve (Tier A), dummy key only.
 */
export {
  DUMMY_LOCAL_KEY,
  type EnsureLocalModel,
  type LocalRepointOpts,
  type LocalRepointPlan,
  planLocalRepoint,
  repointToLocal,
} from "./localaiRepoint.js";
