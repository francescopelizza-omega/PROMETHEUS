/**
 * __test-doubles__/zod.mjs — a faithful MINIMAL zod stand-in for node:test.
 *
 * The real `zod` package is a runtime dependency of @prometheus/desktop
 * (apps/desktop/package.json) used ONLY by main/validate.ts at the IPC seam, and
 * ONLY in the privileged main process. The decoupled node:test runner (driven by
 * apps/cli/dev-register.mjs) intentionally has no bundler and no installed
 * app-level node_modules, so it cannot resolve the real `zod`.
 *
 * This double implements the EXACT, narrow zod surface main/validate.ts uses —
 * `z.string().trim().min().max().regex()`, `z.boolean().optional().default()`,
 * `z.enum()`, `z.object({}).safeParse()`, and a `ZodError`-shaped failure with
 * `.issues[].message` + `.path` — with the SAME semantics real zod gives for
 * those calls (trim-then-validate ordering, default-on-undefined, first-issue
 * reporting). The dev-resolver maps the bare specifier `zod` here when running
 * tests, so validate.ts's REAL schema definitions execute against it.
 *
 * It is a TEST artefact only; production bundles the real zod via electron-vite.
 * Behaviours are intentionally kept 1:1 with the pure guards in arg-guards.ts so
 * the agreement tests in validate.test.ts are meaningful, not self-fulfilling.
 */

/** A single validation issue, matching the fields validate.ts reads. */
class Issue {
  constructor(message, path = []) {
    this.message = message;
    this.path = path;
  }
}

/** A ZodError-shaped failure carrying the ordered issues. */
export class ZodError extends Error {
  constructor(issues) {
    super(issues[0]?.message ?? "invalid");
    this.name = "ZodError";
    this.issues = issues;
  }
}

/** Base schema: a single `_parse(value) -> {ok,value}|{ok:false,issue}`. */
class Schema {
  constructor(parse) {
    this._parse = parse;
  }

  /** zod's public surface used by validate.ts: safeParse returns success|error. */
  safeParse(input) {
    const r = this._parse(input);
    if (r.ok) return { success: true, data: r.value };
    return { success: false, error: new ZodError([r.issue]) };
  }

  /** Wrap so `undefined` short-circuits to a valid (undefined) value. */
  optional() {
    return new OptionalSchema(this);
  }

  /** Wrap so `undefined` OR `null` short-circuits to a valid (undefined) value. */
  nullish() {
    return new NullishSchema(this);
  }

  /** Wrap so `undefined` becomes the supplied default (post-optional in real zod). */
  default(value) {
    return new DefaultSchema(this, value);
  }
}

/** optional(): undefined is allowed and passes through as undefined. */
class OptionalSchema extends Schema {
  constructor(inner) {
    super((input) => (input === undefined ? { ok: true, value: undefined } : inner._parse(input)));
    this._inner = inner;
  }
  // `.optional().default(x)` — the default fires for undefined.
  default(value) {
    return new DefaultSchema(this._inner, value);
  }
}

/** default(v): undefined yields v, otherwise the inner schema validates. */
class DefaultSchema extends Schema {
  constructor(inner, value) {
    super((input) => (input === undefined ? { ok: true, value } : inner._parse(input)));
  }
}

/** nullish(): undefined OR null is allowed and passes through as undefined. */
class NullishSchema extends Schema {
  constructor(inner) {
    super((input) =>
      input === undefined || input === null ? { ok: true, value: undefined } : inner._parse(input),
    );
    this._inner = inner;
  }
}

/** number(): chained int/min/max refinements (in call order). */
class NumberSchema extends Schema {
  constructor(steps = []) {
    super((input) => {
      if (typeof input !== "number" || Number.isNaN(input)) {
        return { ok: false, issue: new Issue("Expected number") };
      }
      for (const step of steps) {
        const issue = step.check(input);
        if (issue) return { ok: false, issue: new Issue(issue) };
      }
      return { ok: true, value: input };
    });
    this._steps = steps;
  }
  _with(step) {
    return new NumberSchema([...this._steps, step]);
  }
  int(msg) {
    return this._with({ check: (v) => (Number.isInteger(v) ? null : (msg ?? "Expected integer")) });
  }
  min(n, msg) {
    return this._with({ check: (v) => (v < n ? (msg ?? `min ${n}`) : null) });
  }
  max(n, msg) {
    return this._with({ check: (v) => (v > n ? (msg ?? `max ${n}`) : null) });
  }
}

/** unknown(): any value (including undefined) passes through unchanged. */
class UnknownSchema extends Schema {
  constructor() {
    super((input) => ({ ok: true, value: input }));
  }
}

/** A string schema with chained trim/min/max/regex refinements (in call order). */
class StringSchema extends Schema {
  constructor(steps = []) {
    super((input) => {
      if (typeof input !== "string") {
        return { ok: false, issue: new Issue("Expected string") };
      }
      let value = input;
      for (const step of steps) {
        if (step.kind === "trim") {
          value = value.trim();
          continue;
        }
        const issue = step.check(value);
        if (issue) return { ok: false, issue: new Issue(issue) };
      }
      return { ok: true, value };
    });
    this._steps = steps;
  }
  _with(step) {
    return new StringSchema([...this._steps, step]);
  }
  trim() {
    return this._with({ kind: "trim" });
  }
  min(n, msg) {
    return this._with({ check: (v) => (v.length < n ? (msg ?? `min ${n}`) : null) });
  }
  max(n, msg) {
    return this._with({ check: (v) => (v.length > n ? (msg ?? `max ${n}`) : null) });
  }
  regex(re, msg) {
    return this._with({ check: (v) => (re.test(v) ? null : (msg ?? "invalid")) });
  }
}

/** enum([...]): value must be one of the literals. */
class EnumSchema extends Schema {
  constructor(values) {
    super((input) =>
      values.includes(input)
        ? { ok: true, value: input }
        : { ok: false, issue: new Issue(`Expected one of ${values.join("|")}`) },
    );
  }
}

/** boolean(): strict boolean. */
class BooleanSchema extends Schema {
  constructor() {
    super((input) =>
      typeof input === "boolean"
        ? { ok: true, value: input }
        : { ok: false, issue: new Issue("Expected boolean") },
    );
  }
}

/**
 * array(inner): every element must satisfy `inner`; prefixes the failing index.
 * Supports `.min(n,msg)` / `.max(n,msg)` length bounds (checked BEFORE elements,
 * matching real zod's order) and inherits `.optional()` / `.default()` from Schema.
 */
class ArraySchema extends Schema {
  constructor(inner, bounds = {}) {
    super((input) => {
      if (!Array.isArray(input)) {
        return { ok: false, issue: new Issue("Expected array") };
      }
      if (bounds.min !== undefined && input.length < bounds.min) {
        return { ok: false, issue: new Issue(bounds.minMsg ?? `min ${bounds.min}`) };
      }
      if (bounds.max !== undefined && input.length > bounds.max) {
        return { ok: false, issue: new Issue(bounds.maxMsg ?? `max ${bounds.max}`) };
      }
      const out = [];
      for (let i = 0; i < input.length; i++) {
        const r = inner._parse(input[i]);
        if (!r.ok) {
          const path = [i, ...(r.issue.path ?? [])];
          return { ok: false, issue: new Issue(r.issue.message, path) };
        }
        out.push(r.value);
      }
      return { ok: true, value: out };
    });
    this._inner = inner;
    this._bounds = bounds;
  }
  min(n, msg) {
    return new ArraySchema(this._inner, { ...this._bounds, min: n, minMsg: msg });
  }
  max(n, msg) {
    return new ArraySchema(this._inner, { ...this._bounds, max: n, maxMsg: msg });
  }
}

/** literal(v): exact-value match (the discriminatedUnion discriminant leaf). */
class LiteralSchema extends Schema {
  constructor(value) {
    super((input) =>
      input === value
        ? { ok: true, value: input }
        : { ok: false, issue: new Issue(`Expected literal ${JSON.stringify(value)}`) },
    );
    this._literal = value;
  }
}

/**
 * object({...}): validates each field, prefixing the failing field's path.
 * `.strict()` mirrors real zod: unknown keys become an "Unrecognized key(s)"
 * issue instead of being silently stripped.
 */
class ObjectSchema extends Schema {
  constructor(shape, strict = false) {
    super((input) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        return { ok: false, issue: new Issue("Expected object") };
      }
      if (strict) {
        // hasOwn, not `in`: a key named "toString"/"constructor" must count as
        // extra (the `in` operator would find it on the prototype chain)
        const extras = Object.keys(input).filter((k) => !Object.hasOwn(shape, k));
        if (extras.length > 0) {
          return {
            ok: false,
            issue: new Issue(
              `Unrecognized key(s) in object: ${extras.map((k) => `'${k}'`).join(", ")}`,
            ),
          };
        }
      }
      const out = {};
      for (const [key, schema] of Object.entries(shape)) {
        const r = schema._parse(input[key]);
        if (!r.ok) {
          const path = [key, ...(r.issue.path ?? [])];
          return { ok: false, issue: new Issue(r.issue.message, path) };
        }
        if (r.value !== undefined) out[key] = r.value;
      }
      return { ok: true, value: out };
    });
    this._shape = shape;
  }
  strict() {
    return new ObjectSchema(this._shape, true);
  }
}

/**
 * discriminatedUnion(key, options): O(1) branch pick on the literal discriminant,
 * with real zod's precise "Invalid discriminator value" failure (path = [key])
 * when no branch matches — never a per-branch error spray like plain union.
 */
class DiscriminatedUnionSchema extends Schema {
  constructor(key, options) {
    super((input) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        return { ok: false, issue: new Issue("Expected object") };
      }
      const branch = options.find((o) => o._shape?.[key]?._literal === input[key]);
      if (!branch) {
        const expected = options.map((o) => `'${o._shape?.[key]?._literal}'`).join(" | ");
        return {
          ok: false,
          issue: new Issue(`Invalid discriminator value. Expected ${expected}`, [key]),
        };
      }
      return branch._parse(input);
    });
  }
}

/**
 * record(keySchema, valueSchema): every own key/value must satisfy its schema
 * (real zod's two-arg form; the failing key becomes the issue path).
 */
class RecordSchema extends Schema {
  constructor(keySchema, valueSchema) {
    super((input) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        return { ok: false, issue: new Issue("Expected object") };
      }
      const out = {};
      for (const [k, v] of Object.entries(input)) {
        const kr = keySchema._parse(k);
        if (!kr.ok) return { ok: false, issue: new Issue(kr.issue.message, [k]) };
        const vr = valueSchema._parse(v);
        if (!vr.ok) return { ok: false, issue: new Issue(vr.issue.message, [k]) };
        out[kr.value] = vr.value;
      }
      return { ok: true, value: out };
    });
  }
}

export const z = {
  string: () => new StringSchema(),
  boolean: () => new BooleanSchema(),
  number: () => new NumberSchema(),
  unknown: () => new UnknownSchema(),
  enum: (values) => new EnumSchema(values),
  literal: (value) => new LiteralSchema(value),
  object: (shape) => new ObjectSchema(shape),
  array: (inner) => new ArraySchema(inner),
  record: (keySchema, valueSchema) => new RecordSchema(keySchema, valueSchema),
  discriminatedUnion: (key, options) => new DiscriminatedUnionSchema(key, options),
  ZodError,
};

export default { z, ZodError };
