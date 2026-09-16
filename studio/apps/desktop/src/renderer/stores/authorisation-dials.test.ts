/**
 * authorisation-dials.test.ts — the two posture dials must never disagree.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { effectiveAuthLevel, useAuthorisationStore } from "./authorisation.js";

test("raising the authorisation level clears plan mode", () => {
  /**
   * `setPermissionMode` syncs the level (`plan` pins it to 0 so no ladder rung can auto-approve
   * underneath a read-only posture) — but `setLevel` did NOT sync the mode. Picking a level while
   * in plan mode left `permissionMode: "plan"` beside a level that auto-approves: the indicator
   * said read-only while the behaviour was not. That is exactly the failure this store's own
   * docstring records — "two independent dials over one concept is how the TUI's indicator and
   * its actual behaviour came apart once already".
   */
  const s = () => useAuthorisationStore.getState();

  s().setPermissionMode("plan");
  assert.equal(s().permissionMode, "plan");
  assert.equal(s().level, 0, "precondition: plan pins the level to 0");

  s().setLevel(5);
  assert.equal(s().level, 5);
  assert.notEqual(
    s().permissionMode,
    "plan",
    "the indicator still says plan while the level auto-approves",
  );

  // …and dropping back to 0 does NOT silently re-enter plan mode: plan is a deliberate posture,
  // not merely "level 0".
  s().setLevel(0);
  assert.notEqual(s().permissionMode, "plan");
});

test("setPermissionMode still drives the level, in both directions", () => {
  // self-validating: the sync that already worked must keep working.
  const s = () => useAuthorisationStore.getState();
  s().setPermissionMode("plan");
  assert.equal(s().level, 0);
  s().setPermissionMode("default");
  assert.equal(s().permissionMode, "default");
});

/**
 * The GUI half of "one setting, not three".
 *
 * The store persisted through localStorage alone, and it persisted on EVERY level change —
 * including the ones the permission-mode dial derives. Both are the same defect the CLI had:
 * a session-scoped posture change silently rewriting the operator's explicit choice, in a place
 * no other surface could see.
 */
test("the mode dial moves the live level but never writes it to the shared store", () => {
  const writes: number[] = [];
  const g = globalThis as unknown as { window?: unknown };
  const hadWindow = "window" in g;
  g.window = {
    localStorage: {
      store: new Map<string, string>(),
      getItem(k: string): string | null {
        return (this.store as Map<string, string>).get(k) ?? null;
      },
      setItem(k: string, v: string): void {
        (this.store as Map<string, string>).set(k, v);
      },
    },
    prometheus: {
      authLevel: {
        get: async () => ({ ok: true, level: null }),
        set: async (level: number) => {
          writes.push(level);
          return { ok: true, level };
        },
      },
    },
  };
  try {
    const store = useAuthorisationStore.getState();

    // an EXPLICIT pick reaches the shared file
    store.setLevel(6);
    assert.deepEqual(writes, [6]);

    // the coarse posture does not — mode→level is lossy, and persisting the derived value is
    // exactly what replaced a deliberate 7 with 2 on the CLI side
    useAuthorisationStore.getState().setPermissionMode("acceptEdits");
    assert.equal(useAuthorisationStore.getState().level, 2, "the live level follows the mode");
    assert.deepEqual(writes, [6], "the mode dial must not rewrite the saved preference");

    useAuthorisationStore.getState().setPermissionMode("plan");
    assert.equal(useAuthorisationStore.getState().level, 0);
    assert.deepEqual(writes, [6], "plan mode is a stance, not a stored preference");
  } finally {
    // Reflect.deleteProperty, not `delete`: biome flags the operator and its suggested fix
    // (`= undefined`) would leave a defined-but-undefined `window` for later suites.
    if (!hadWindow) Reflect.deleteProperty(g, "window");
  }
});

/* -- the label and the enforcement must read the SAME level -- */

test("effectiveAuthLevel is the min of the session and the stored level", () => {
  // main takes the same min (ai-ipc.ts), so a session posture may tighten and never raise.
  assert.equal(effectiveAuthLevel(7, 1), 1, "a yolo dial cannot exceed the stored preference");
  assert.equal(effectiveAuthLevel(0, 6), 0, "a plan posture must tighten");
  assert.equal(effectiveAuthLevel(5, 5), 5);
});

test("before hydration the session level stands alone", () => {
  // savedLevel is null until the first read answers; falling back to 0 would grey every
  // cloud row for one frame on every launch.
  assert.equal(effectiveAuthLevel(6, null), 6);
});

test("an explicit setLevel records the stored value immediately", () => {
  // otherwise effectiveAuthLevel would keep min-ing against a stale savedLevel until the
  // next hydrate, and the Hub would contradict a level the user just chose.
  useAuthorisationStore.getState().setLevel(6);
  assert.equal(useAuthorisationStore.getState().savedLevel, 6);
  assert.equal(useAuthorisationStore.getState().level, 6);
});

test("a posture change moves the SESSION level and leaves the stored one alone", () => {
  useAuthorisationStore.getState().setLevel(7);
  assert.equal(useAuthorisationStore.getState().savedLevel, 7);
  useAuthorisationStore.getState().setPermissionMode("plan");
  const s = useAuthorisationStore.getState();
  assert.equal(s.level, 0, "plan pins the session to 0");
  assert.equal(s.savedLevel, 7, "…without overwriting the operator's explicit pick");
  assert.equal(effectiveAuthLevel(s.level, s.savedLevel), 0, "and the gate follows the tighter");
});
