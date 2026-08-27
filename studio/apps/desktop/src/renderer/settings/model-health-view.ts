/**
 * model-health-view.ts — pure Settings ▸ Model Health helpers.
 *
 * Split out of ModelHealthPage.tsx (mirrors this dir's own hooks-panel.ts / HooksPage.tsx
 * split): the run-tests.mjs node:test runner executes suites straight from TS source via
 * Node's native type-stripping loader (apps/cli/dev-resolver.mjs), which erases TYPE
 * annotations but does NOT transform JSX — a `.tsx` file can't be `import`ed by a test at
 * all (see that resolver's own comment on why it never bare-maps root "@prometheus/ui").
 * So the two pure mapping/formatting helpers this page needs tested live here, in a plain
 * `.ts` sibling, exactly like every other Settings sub-page's pure logic does.
 *
 * PURE — no DOM, no IPC, no React.
 */
import type { EndpointHealthRecord } from "@prometheus/core/ai-model-health";
import type { HealthViewStatus } from "@prometheus/ui";

/**
 * The transport `StatusPill`'s status: a rejected native attempt is a hard "down" (the
 * endpoint told us no), demonstrated native use is "ok", and "we haven't tried/seen it
 * succeed yet" is "unknown" — never a false "ok" for a transport that's merely unproven.
 */
export function transportPillStatus(
  record: Pick<EndpointHealthRecord, "demonstrated" | "nativeRejected">,
): HealthViewStatus {
  if (record.nativeRejected) return "down";
  return record.demonstrated ? "ok" : "unknown";
}

/** The breaker `StatusPill`'s status: closed ⇒ ok, half-open ⇒ degraded (recovering), open ⇒ down. */
export function breakerPillStatus(
  breakerState: EndpointHealthRecord["breakerState"],
): HealthViewStatus {
  return breakerState === "closed" ? "ok" : breakerState === "half-open" ? "degraded" : "down";
}

/**
 * A short "Nm ago" caption for `lastUsedIso`, given the current time — kept as an explicit
 * `nowMs` parameter (rather than reading `Date.now()` internally) so it stays pure and
 * deterministically testable; the component supplies "now" itself.
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const diffMs = Math.max(0, nowMs - then);
  const sec = Math.round(diffMs / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month}mo ago`;
  const year = Math.round(month / 12);
  return `${year}y ago`;
}
