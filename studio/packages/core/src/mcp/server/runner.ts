/**
 * mcp/server/runner.ts — validate tool args + dispatch through the engine (file 09 §1/§3).
 *
 * `validateArgs` is the pure, dependency-free validator over a ToolSchema (FieldSpec
 * map): it applies defaults, checks required/types/enums, and drops unknown keys.
 * `runMcpTool` validates, builds argv via the tool's `toArgv`, and runs it through
 * `@prometheus/engine-bridge` runPrometheus (the §1.1 reused bridge — shell:false,
 * 600 s fail-closed, single-envelope recovery). The runner is INJECTABLE (opts.run)
 * so tests dispatch a fake without spawning python.
 */
import { type EngineEnvelope, type RunOptions, runPrometheus } from "@prometheus/engine-bridge";
import type { ToolDef, ToolSchema } from "./tools.js";

/** Result of validating raw args against a ToolSchema. */
export interface ValidationResult {
  ok: boolean;
  value: Record<string, unknown>;
  errors: string[];
}

/**
 * Validate + coerce raw args against a tool schema (pure). Applies declared
 * defaults, enforces required + type + enum, and IGNORES unknown keys (lenient,
 * matching MCP). Never throws — returns a result the caller inspects.
 */
export function validateArgs(schema: ToolSchema, args: Record<string, unknown>): ValidationResult {
  const value: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [key, spec] of Object.entries(schema)) {
    const raw = args[key];
    if (raw === undefined || raw === null) {
      if (spec.default !== undefined) value[key] = spec.default;
      else if (spec.required) errors.push(`missing required arg "${key}"`);
      continue;
    }
    if (spec.type === "string" || spec.type === "enum") {
      if (typeof raw !== "string") {
        errors.push(`arg "${key}" must be a string`);
        continue;
      }
      if (spec.type === "enum" && spec.enum && !spec.enum.includes(raw)) {
        errors.push(`arg "${key}" must be one of: ${spec.enum.join(", ")}`);
        continue;
      }
    } else if (spec.type === "boolean") {
      if (typeof raw !== "boolean") {
        errors.push(`arg "${key}" must be a boolean`);
        continue;
      }
    } else if (spec.type === "number") {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        errors.push(`arg "${key}" must be a finite number`);
        continue;
      }
    } else if (spec.type === "array") {
      // A JSON STRING that parses to an array is accepted, because that is what models
      // actually send — `parseHunks` has tolerated exactly this since before there was an
      // array type to declare. Rejecting it here would break the calls that work today.
      if (typeof raw === "string") {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!Array.isArray(parsed)) {
            errors.push(`arg "${key}" must be an array`);
            continue;
          }
          value[key] = parsed;
          continue;
        } catch {
          errors.push(`arg "${key}" must be an array (or a JSON string holding one)`);
          continue;
        }
      }
      if (!Array.isArray(raw)) {
        errors.push(`arg "${key}" must be an array`);
        continue;
      }
    }
    value[key] = raw;
  }

  return { ok: errors.length === 0, value, errors };
}

/** A runner that executes a prometheus argv → an engine envelope (engine-bridge shape). */
export type EngineRunner = (argv: string[], opts?: RunOptions) => Promise<EngineEnvelope>;

export interface RunMcpToolOptions {
  /** override the engine runner (tests inject a fake; default = engine-bridge). */
  run?: EngineRunner;
  runOptions?: RunOptions;
}

/**
 * Validate args, build the tool's argv, and dispatch it through the engine bridge.
 * Throws an Error (caught by the MCP layer → an error result) if validation fails —
 * the engine is never invoked with bad input.
 */
export function runMcpTool(
  tool: ToolDef,
  args: Record<string, unknown> = {},
  opts: RunMcpToolOptions = {},
): Promise<EngineEnvelope> {
  const parsed = validateArgs(tool.schema, args);
  if (!parsed.ok) {
    return Promise.reject(new Error(`invalid args for ${tool.name}: ${parsed.errors.join("; ")}`));
  }
  const argv = tool.toArgv(parsed.value);
  const run: EngineRunner = opts.run ?? runPrometheus;
  return run(argv, opts.runOptions);
}
