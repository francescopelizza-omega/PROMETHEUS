/**
 * ai/connectors/types.ts — the runtime shapes the 4 connector kinds produce (file 12 §1.2).
 *
 * A connector BUILDER turns a (validated) ConnectorConfig + its Provider row into a
 * ready-to-use runtime descriptor — WITHOUT ever embedding a secret:
 *  - the http kinds (local-serve / api-key / oauth-bridge) → a `ConnectorEndpoint`
 *    (an AiEndpoint for file-07's `createAiClient` + a LAZY key resolver that reads
 *    the OS keychain only at request time);
 *  - cli-passthrough → a `CliLaunchSpec` that MUST clear a nemesis gate before spawn.
 *
 * The runtime deps (keychain, gate, spawn) are injected — core stays pure + testable.
 */
import type { AiEndpoint, KeyResolver } from "../client.js";

/** A self-contained http-connector runtime: endpoint + extra headers + lazy key resolver. */
export interface ConnectorEndpoint {
  endpoint: AiEndpoint;
  /** provider-specific headers (e.g. Anthropic `anthropic-beta` for the oauth bridge). */
  extraHeaders?: Record<string, string>;
  /** resolve the secret LAZILY from the keychain at request time (never stored inline). */
  resolveKey?: KeyResolver;
}

/** A spawn spec for a cli-passthrough connector — the vendor CLI owns its own auth/billing. */
export interface CliLaunchSpec {
  providerId: string;
  bin: string;
  args: string[];
  /** env for the child. cli-passthrough providers manage their OWN creds, so this is
   *  normally empty — any value here is redacted from captured stderr (see redactKeys). */
  env: Record<string, string>;
  /** extra env keys to redact from captured stderr beyond the built-in secret-key set. */
  redactKeys: string[];
}

/** A nemesis gate decision (mirrors the engine's tiers; dependency-free). */
export interface GateVerdict {
  decision: "allow" | "warn" | "block" | "error";
  reason?: string;
}

/** The nemesis-gate seam: vet a launch BEFORE the first spawn (file 12 §1.2 cli kind). */
export type GateFn = (spec: CliLaunchSpec) => Promise<GateVerdict>;

/** The minimal process spawn seam (injected; node:child_process lives in the shell). */
export type SpawnLike = (
  bin: string,
  args: string[],
  opts: { env: Record<string, string> },
) => { pid?: number };

/** Raised when a connector cannot be built/launched (lists the blocking reasons). */
export class ConnectorError extends Error {
  readonly reasons: string[];
  constructor(message: string, reasons: string[] = []) {
    super(reasons.length ? `${message}: ${reasons.join("; ")}` : message);
    this.name = "ConnectorError";
    this.reasons = reasons;
  }
}

/** Re-export the endpoint type so connector consumers import from one place. */
export type { AiEndpoint, KeyResolver } from "../client.js";
