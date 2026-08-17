/**
 * renderer/visual-harness.tsx — the decision-card visual baseline surface (HANDOFF_2 §9).
 *
 * §9 requires one committed screenshot baseline per redesigned surface, INCLUDING the
 * verdict card and the permission card. Those two cannot be reached in e2e the way the
 * others can: the verdict card needs a real nemesis scan and the permission card needs a
 * real proposed edit from a served model, and neither exists in a headless run with no
 * engine and no model. Driving them through fake IPC would be a screenshot of the fakes.
 *
 * So they get rendered directly, with FIXED props, on a route that only mounts when
 * `localStorage["prometheus.e2e.visualHarness"] === "1"`. That key is set by the e2e spec
 * and by nothing else in the app.
 *
 * Why this is safe to ship: everything below is a pure presentational component with
 * literal props. It reads no state, calls no IPC, touches no filesystem, and its buttons
 * are no-ops. Someone who set the key by hand would see two static cards — there is no
 * capability here to reach.
 *
 * The point of the fixed props is that the baseline has to be about LAYOUT. Real data
 * changes between runs; these strings are chosen to exercise the hard cases — a long
 * artifact path, a finding whose `where` is long enough to compete with its description,
 * and an outside-the-working-set target (the loud branch of the permission card).
 */

import { PermissionCard, VerdictCard } from "@prometheus/ui";
import type { ReactElement } from "react";

/** The localStorage key the e2e spec sets to reach this surface. */
export const VISUAL_HARNESS_KEY = "prometheus.e2e.visualHarness";

/** Is the harness requested? Guarded so a missing/blocked localStorage never throws. */
export function visualHarnessRequested(): boolean {
  try {
    return globalThis.localStorage?.getItem(VISUAL_HARNESS_KEY) === "1";
  } catch {
    return false;
  }
}

const NOOP = (): void => {};

export function VisualHarness(): ReactElement {
  return (
    <div
      aria-label="visual harness"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 20,
        background: "var(--bg-app)",
        minHeight: "100vh",
        fontFamily: "var(--font-ui)",
      }}
    >
      <div data-testid="baseline-verdict-card" style={{ maxWidth: 560 }}>
        <VerdictCard
          verdict="block"
          artifact="github.com/example-org/some-plugin-with-a-long-name"
          sourceKind="unsigned"
          riskScore={87}
          findings={[
            {
              rule: "N-204",
              severity: "critical",
              description: "obfuscated payload executes on import",
              where: "src/vendor/bundle.min.js:1",
            },
            {
              rule: "N-117",
              severity: "high",
              description: "writes outside the install prefix",
              where: "scripts/postinstall.sh:42",
            },
            {
              rule: "N-089",
              severity: "medium",
              description: "network call to an undeclared host",
              where: "src/telemetry/report.ts:118",
            },
          ]}
          onDetails={NOOP}
          onInstallAnyway={NOOP}
          onQuarantine={NOOP}
        />
      </div>

      <div data-testid="baseline-permission-card" style={{ maxWidth: 560 }}>
        <PermissionCard
          kind="write file"
          target="/Users/operator/notes/outside-the-workspace/config.yaml"
          insideWorkingSet={false}
          change="modify"
          magnitude="4 lines"
          authLevel={3}
          authVar="--auth-3"
          onAllowOnce={NOOP}
          onAllowSession={NOOP}
          onDeny={NOOP}
        />
      </div>
    </div>
  );
}

export default VisualHarness;
