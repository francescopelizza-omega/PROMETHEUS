/**
 * Layout.tsx — Separator, Avatar, Skeleton, Progress, ScrollArea (file 08 §3.1).
 *
 * Small structural/feedback atoms, all token-styled. Progress is determinate by
 * default (08 §2.5: "Long engine ops never spin a fake bar"); pass `value=undefined`
 * for an indeterminate sub-second wait. Skeleton honours prefers-reduced-motion via
 * the global stylesheet (the shimmer is a CSS class, not JS). ScrollArea is a styled
 * overflow container (Radix swaps in custom scrollbars later).
 */

import { type CSSProperties, type ReactNode, forwardRef } from "react";
import { fs, rad, sp, v } from "./styles.js";

/* ── Separator ───────────────────────────────────────────────────────────────── */

export interface SeparatorProps {
  orientation?: "horizontal" | "vertical";
  className?: string;
}

export function Separator({ orientation = "horizontal", className }: SeparatorProps): ReactNode {
  const horizontal = orientation === "horizontal";
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: WAI-ARIA `separator` is a structural, non-focusable role (no tabindex by spec); Radix's Separator renders the same div+role.
    <div
      role="separator"
      aria-orientation={orientation}
      className={className}
      style={{
        background: v("border-subtle"),
        ...(horizontal ? { height: "1px", width: "100%" } : { width: "1px", alignSelf: "stretch" }),
      }}
    />
  );
}

/* ── Avatar ──────────────────────────────────────────────────────────────────── */

export interface AvatarProps {
  /** Initials/glyph fallback when no image (e.g. an agent's mark). */
  fallback: ReactNode;
  src?: string;
  alt?: string;
  size?: number;
  className?: string;
}

export function Avatar({ fallback, src, alt, size = 28, className }: AvatarProps): ReactNode {
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: rad("full"),
        background: v("bg-surface-2"),
        border: `1px solid ${v("border-subtle")}`,
        color: v("text-secondary"),
        fontFamily: v("font-ui"),
        fontSize: `${Math.round(size * 0.4)}px`,
        fontWeight: 600,
        overflow: "hidden",
      }}
    >
      {src != null ? (
        <img
          src={src}
          alt={alt ?? ""}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <span aria-hidden={alt == null}>{fallback}</span>
      )}
    </span>
  );
}

/* ── Skeleton ────────────────────────────────────────────────────────────────── */

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: "sm" | "md" | "lg" | "full";
  className?: string;
}

export function Skeleton({
  width = "100%",
  height = 16,
  radius = "md",
  className,
}: SkeletonProps): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={`prom-skeleton ${className ?? ""}`.trim()}
      style={{
        display: "block",
        width: typeof width === "number" ? `${width}px` : width,
        height: typeof height === "number" ? `${height}px` : height,
        borderRadius: rad(radius),
        background: v("bg-surface-2"),
        // the shimmer animation lives in the global stylesheet (reduced-motion safe).
      }}
    />
  );
}

/* ── Progress ────────────────────────────────────────────────────────────────── */

export interface ProgressProps {
  /** 0..100; omit for an indeterminate bar (sub-second waits only, 08 §2.5). */
  value?: number;
  max?: number;
  /** A semantic tint for the fill (default brand). */
  tone?: "brand" | "ok" | "warn" | "danger" | "accent";
  "aria-label"?: string;
  className?: string;
}

export function Progress({
  value,
  max = 100,
  tone = "brand",
  "aria-label": ariaLabel,
  className,
}: ProgressProps): ReactNode {
  const determinate = typeof value === "number";
  const pct = determinate ? Math.max(0, Math.min(100, (value / max) * 100)) : undefined;
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: WAI-ARIA `progressbar` is a non-focusable live status role (no tabindex by spec); Radix's Progress renders the same div+role.
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={determinate ? value : undefined}
      aria-valuemin={0}
      aria-valuemax={max}
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "6px",
        borderRadius: rad("full"),
        background: v("border-subtle"),
        overflow: "hidden",
      }}
    >
      <div
        className={determinate ? undefined : "prom-progress-indeterminate"}
        style={{
          height: "100%",
          width: determinate ? `${pct}%` : "40%",
          borderRadius: rad("full"),
          background: v(tone),
          transition: "width var(--motion-panel, 180ms) ease-out",
        }}
      />
    </div>
  );
}

/* ── ScrollArea ──────────────────────────────────────────────────────────────── */

export interface ScrollAreaProps {
  maxHeight?: string | number;
  className?: string;
  children?: ReactNode;
  style?: CSSProperties;
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { maxHeight, className, children, style },
  ref,
) {
  return (
    <div
      ref={ref}
      className={`prom-scroll-area ${className ?? ""}`.trim()}
      style={{
        overflow: "auto",
        maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight,
        ...style,
      }}
    >
      {children}
    </div>
  );
});

export default Separator;
