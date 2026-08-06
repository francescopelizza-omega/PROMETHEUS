/**
 * agent/duration.ts — human elapsed-time formatter for turn / subtask timing.
 *
 * Renders a millisecond span as `Nd Nh Nm Ns`, DROPPING every component that is zero
 * (the rule: a counter that stays 0 is not printed). Examples:
 *   40_000     → "40s"
 *   90_000     → "1m 30s"
 *   3_601_000  → "1h 1s"          (the 0m is dropped)
 *   90_000_000 → "1d 1h"          (25h = 1d 1h 0m 0s → drop the zeros)
 *   400        → "0s"             (sub-second / zero floors to 0s so there's always output)
 *
 * PURE. The host paints it (dim/grey) at the end of a subtask or the whole prompt.
 */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.floor(safe / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const mins = Math.floor((totalSec % 3_600) / 60);
  const secs = totalSec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0) parts.push(`${secs}s`);
  return parts.length > 0 ? parts.join(" ") : "0s";
}
