// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * components/util — the shadcn class utilities (file 08 §3): `cn` (clsx +
 * tailwind-merge) and `cva` (class-variance-authority), reimplemented
 * dependency-free for this env (see each file's header). The real packages are
 * DECLARED in package.json and swap in 1:1 once the orchestrator installs them.
 */
export { cn } from "./cn.js";
export type { ClassValue, ClassDict } from "./cn.js";
export { cva } from "./cva.js";
export type { CvaConfig, CvaProps, VariantProps } from "./cva.js";
