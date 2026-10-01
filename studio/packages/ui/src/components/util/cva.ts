// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * components/util/cva.ts — the variant compositor (file 08 §3, `class-variance-authority`).
 *
 * shadcn primitives express their look as a `cva()` config: a base class + named
 * variant axes (e.g. `variant`, `size`) + `defaultVariants` + optional
 * `compoundVariants`. `class-variance-authority` is DECLARED in package.json (the
 * task's heavy-dep list) but NOT installed here.
 *
 * ENV LIMIT (honest) — same discipline as cn.ts / engine-bridge modelhub/types.ts:
 * a static `import { cva } from "class-variance-authority"` breaks `tsc -b` here
 * (TS2307), and the task forbids installs. So we implement the SAME contract — a
 * factory that resolves a props object to a className via `cn()` — dependency-free.
 * The public shape (`VariantProps<typeof x>`, the `(props) => string` callable,
 * `defaultVariants`, `compoundVariants`) matches CVA so a 1:1 swap is trivial once
 * the orchestrator links the real package.
 */

import { type ClassValue, cn } from "./cn.js";

/** A single variant axis: option name → class value. */
type VariantAxis = Record<string, ClassValue>;
/** The variants config: axis name → its options. */
type VariantsConfig = Record<string, VariantAxis>;

/** Selected option per axis (string keys of the axis). */
type VariantSelection<V extends VariantsConfig> = {
  [K in keyof V]?: keyof V[K] | boolean | null | undefined;
};

/** A compound rule: when these selections all match, add `class`. */
type CompoundVariant<V extends VariantsConfig> = VariantSelection<V> & { class: ClassValue };

export interface CvaConfig<V extends VariantsConfig> {
  variants?: V;
  defaultVariants?: VariantSelection<V>;
  compoundVariants?: CompoundVariant<V>[];
}

/** The props a cva callable accepts: a selection over its axes, plus a `className`. */
export type CvaProps<V extends VariantsConfig> = VariantSelection<V> & {
  className?: string;
  class?: ClassValue;
};

/** Public mirror of CVA's `VariantProps<typeof component>` helper. */
export type VariantProps<T extends (props?: never) => string> = T extends (
  props?: infer P,
) => string
  ? Omit<NonNullable<P>, "className" | "class">
  : never;

/** Normalise an axis option key from a boolean/string selection. */
function optionKey(value: unknown): string | undefined {
  if (value === true) return "true";
  if (value === false) return "false";
  if (value == null) return undefined;
  return String(value);
}

/**
 * cva — build a variant-driven className function. Resolves: base ▸ each axis's
 * selected (or default) option ▸ matching compound rules ▸ the caller `className`.
 */
export function cva<V extends VariantsConfig>(base: ClassValue, config: CvaConfig<V> = {}) {
  const { variants, defaultVariants, compoundVariants } = config;

  return function resolve(props?: CvaProps<V>): string {
    const parts: ClassValue[] = [base];
    const selection: Record<string, unknown> = { ...defaultVariants, ...props };

    if (variants) {
      for (const axisName of Object.keys(variants)) {
        const axis = variants[axisName]!;
        const key = optionKey(selection[axisName]);
        if (key !== undefined && key in axis) {
          parts.push(axis[key]);
        }
      }
    }

    if (compoundVariants) {
      for (const rule of compoundVariants) {
        const { class: ruleClass, ...conditions } = rule;
        const matches = Object.entries(conditions).every(
          ([axisName, want]) => optionKey(selection[axisName]) === optionKey(want),
        );
        if (matches) parts.push(ruleClass);
      }
    }

    parts.push(props?.class, props?.className);
    return cn(...parts);
  };
}

export default cva;
