/**
 * force-gate.test.ts — the §9 deep-red override contract.
 *
 * The GUI is the ONLY place a typed confirm can exist for a nemesis BLOCK: the engine's
 * own `install-dangerous` prompt is unreachable from Studio (the sidecar's stdin is a
 * pipe, and the GUI sends `--yes`). So these are the assertions that keep a one-click
 * bypass from coming back.
 *
 * The React component is not rendered here — this app has no DOM test runner. What IS
 * testable, and what actually matters, is (a) the token rule both mirrors agree on and
 * (b) the session-counter state the dialog reports. The component's own gating is a
 * direct call to `matchesForceToken`, pinned below and in packages/ui + packages/core.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FORCE_TOKEN, matchesForceToken } from "@prometheus/ui";

import { useSecurityStore } from "./features.js";

/* ── the token rule the dialog gates on ─────────────────────────────────────── */

test("the force token is the engine's exact phrase", () => {
  // prometheus.py `_confirm_dangerous_override`: `if ans != "install-dangerous"` → abort.
  assert.equal(FORCE_TOKEN, "install-dangerous");
});

test("only the byte-exact token unlocks an override", () => {
  assert.equal(matchesForceToken("install-dangerous"), true);
  // The GUI is deliberately STRICTER than prometheus.py's `.strip().lower()`. Being
  // stricter never weakens the gate; relaxing it to 'match the CLI' would.
  assert.equal(matchesForceToken(" install-dangerous"), false);
  assert.equal(matchesForceToken("install-dangerous "), false);
  assert.equal(matchesForceToken("Install-Dangerous"), false);
  assert.equal(matchesForceToken("install dangerous"), false);
  assert.equal(matchesForceToken(""), false);
  assert.equal(matchesForceToken("yes"), false);
});

/* ── the session counter the dialog surfaces ────────────────────────────────── */

test("forcedThisSession starts at zero and only noteForced advances it", () => {
  const base = useSecurityStore.getState().forcedThisSession;
  useSecurityStore.getState().noteForced();
  assert.equal(useSecurityStore.getState().forcedThisSession, base + 1);
  useSecurityStore.getState().noteForced();
  assert.equal(useSecurityStore.getState().forcedThisSession, base + 2);
});

test("the store exposes NO way to arm an override without a confirmed one", () => {
  // `requestForce` / `clearForce` / `pendingForce` used to live here. Nothing rendered
  // `pendingForce`, so "arming" an override painted no UI — and the security route's
  // Quarantine button called `requestForce`, which meant a button labelled Quarantine
  // silently armed a deep-red BLOCK override and showed nothing. The reducers are gone;
  // the typed confirm in shell/ForceGate.tsx is the only path, and `noteForced` is the
  // only way the counter moves. This test pins that: re-adding a bare "arm it" reducer
  // re-opens the hole.
  const s = useSecurityStore.getState() as Record<string, unknown>;
  assert.equal(s.requestForce, undefined);
  assert.equal(s.clearForce, undefined);
  assert.equal(s.pendingForce, undefined);
  assert.equal(typeof s.noteForced, "function");
});
