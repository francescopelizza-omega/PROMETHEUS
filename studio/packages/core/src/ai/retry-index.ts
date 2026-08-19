/**
 * ai/retry-index.ts — the model-request resilience surface, as one PURE subpath.
 *
 * `retry-policy.ts` and `request.ts` are needed by all four transports, and two of them cannot
 * import core's root barrel: the desktop's sandboxed renderer (C5) and its main process both
 * reach core only through subpaths. Without this file the shared retry would have been
 * copy-pasted into them, which is precisely how this repo ended up with four transports in the
 * first place.
 *
 * Pure: no node, no fetch of its own.
 */
export type { PreflightResult } from "./retry-policy.js";
export {
  AI_RETRY_DEFAULTS,
  AiHttpError,
  ContextOverflowError,
  PREFLIGHT_MARGIN,
  advisedWaitTooLong,
  describeAiFailure,
  isAbort,
  isRetryableAiError,
  isRetryableStatus,
  parseRetryAfter,
  preflightContext,
  retryDelayMs,
} from "./retry-policy.js";
export type { ModelRequestInit, ModelRequestOptions, ModelResponseLike } from "./request.js";
export { endpointBreaker, fetchModelWithRetry } from "./request.js";
