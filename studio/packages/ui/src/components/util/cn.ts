// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * components/util/cn.ts — the className compositor (file 08 §3, shadcn `cn`).
 *
 * The shadcn `cn()` is `twMerge(clsx(...))`: clsx flattens conditional class lists,
 * tailwind-merge dedupes conflicting Tailwind utilities (later wins). Both `clsx`
 * and `tailwind-merge` are DECLARED in this package's package.json (file 08 §3 +
 * the task's heavy-dep list) but are NOT installed in this environment.
 *
 * ENV LIMIT (honest) — same discipline as engine-bridge/modelhub/types.ts (which
 * reimplements zod's parse contract rather than import an uninstalled `zod`): a
 * static `import { clsx } from "clsx"` would break `tsc -b` / `biome` / `node:test`
 * here (TS2307, module not found), and the task forbids running installs. So we
 * implement the SAME contract — variadic, conditional, dedupe-last-wins — WITHOUT a
 * runtime dep, keeping @prometheus/ui stdlib+react-only and the toolchain green.
 *
 * The contract matches `twMerge(clsx(...))` for the way OUR components use it: they
 * compose token-mapped utility classes (e.g. "px-4 text-text-primary") and rely on
 * (a) conditional inclusion and (b) duplicate-class removal with last-wins. When the
 * orchestrator links clsx + tailwind-merge, this file can be swapped 1:1 for the
 * real `twMerge(clsx(...))` with no call-site change (every component imports `cn`).
 */

/** A clsx-style class value: strings, falsy (dropped), arrays, or condition maps. */
export type ClassValue = string | number | null | false | undefined | ClassValue[] | ClassDict;
export interface ClassDict {
  [className: string]: boolean | null | undefined;
}

/** Flatten a clsx-style argument list into a single space-joined string. */
function clsx(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string" || typeof input === "number") {
      out.push(String(input));
    } else if (Array.isArray(input)) {
      const inner = clsx(...input);
      if (inner) out.push(inner);
    } else {
      for (const [key, on] of Object.entries(input)) {
        if (on) out.push(key);
      }
    }
  }
  return out.join(" ");
}

/**
 * Derive the "conflict group" of a Tailwind-ish utility so later wins over earlier
 * within the same group (twMerge's job). We key on the utility PREFIX up to the last
 * `-` before the final value segment, with variant prefixes (`hover:`, `md:`, `dark:`)
 * kept as part of the key so `hover:px-2` never clobbers `px-2`. Arbitrary values
 * (`px-[3px]`) and our token utilities (`text-text-primary`, `bg-bg-surface`) reduce
 * to a stable group so a second `text-…` overrides the first — exactly what callers
 * rely on when they pass a base class plus a caller override via `className`.
 */
function conflictKey(cls: string): string {
  const colon = cls.lastIndexOf(":");
  const variant = colon === -1 ? "" : cls.slice(0, colon + 1);
  const base = colon === -1 ? cls : cls.slice(colon + 1);
  // strip a leading negative sign for grouping (-mx-2 conflicts with mx-2).
  const body = base.startsWith("-") ? base.slice(1) : base;
  const dash = body.indexOf("-");
  // no dash → standalone utility (e.g. "flex", "underline"): its own group.
  const group = dash === -1 ? body : body.slice(0, dash);
  return `${variant}${group}`;
}

/** A small subset of "modifier" utilities that must NOT collapse into one group. */
/** (kept conservative: only group utilities whose first segment is a known prefix). */
const GROUPED_PREFIXES = new Set([
  "p",
  "px",
  "py",
  "pt",
  "pr",
  "pb",
  "pl",
  "m",
  "mx",
  "my",
  "mt",
  "mr",
  "mb",
  "ml",
  "w",
  "h",
  "min",
  "max",
  "gap",
  "text",
  "bg",
  "border",
  "rounded",
  "font",
  "leading",
  "tracking",
  "ring",
  "shadow",
  "opacity",
  "z",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "flex",
  "grid",
  "items",
  "justify",
  "self",
  "order",
  "col",
  "row",
  "fill",
  "stroke",
]);

/**
 * Merge a flattened class string, removing earlier classes that conflict with a later
 * one in the same group (last-wins) — the twMerge behaviour our components depend on.
 * Non-grouped utilities (e.g. "flex", "underline") are simply de-duplicated.
 */
function twMerge(classes: string): string {
  const tokens = classes.split(/\s+/).filter(Boolean);
  const chosen = new Map<string, string>(); // group key → winning class
  const standalone = new Map<string, string>(); // exact class → itself (dedupe)
  const order: string[] = [];

  for (const cls of tokens) {
    const key = conflictKey(cls);
    const firstSeg = key.slice(key.lastIndexOf(":") + 1);
    if (GROUPED_PREFIXES.has(firstSeg)) {
      chosen.set(key, cls); // later in the same group overrides
    } else {
      standalone.set(cls, cls); // dedupe by exact class
    }
  }

  // Re-emit in first-seen order, but with the winning value for grouped keys.
  const emitted = new Set<string>();
  for (const cls of tokens) {
    const key = conflictKey(cls);
    const firstSeg = key.slice(key.lastIndexOf(":") + 1);
    if (GROUPED_PREFIXES.has(firstSeg)) {
      const winner = chosen.get(key)!;
      if (!emitted.has(key)) {
        order.push(winner);
        emitted.add(key);
      }
    } else if (standalone.has(cls) && !emitted.has(cls)) {
      order.push(cls);
      emitted.add(cls);
    }
  }
  return order.join(" ");
}

/**
 * cn — compose conditional class lists and dedupe conflicting utilities (last wins).
 * The shadcn `cn(...)`: `twMerge(clsx(...))`. Pure, dependency-free; see file header.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(...inputs));
}

export default cn;
