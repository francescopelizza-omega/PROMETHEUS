/**
 * negotiate.test.ts — transport choice and the learning that corrects it.
 *
 * The behaviour under test is the one the old code could not express: a WRONG capability
 * guess must cost a turn, not the session. Both directions matter — a local model wrongly
 * marked capable has to fall back, and a cloud model wrongly marked incapable has to stay
 * usable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TEXT_FALLBACK_THRESHOLD,
  type ToolCapabilityState,
  initialCapability,
  looksLikeToolsRejection,
  negotiateTransport,
  observeTurn,
  preambleModeFor,
} from "./negotiate.js";

/* ── the opening move ────────────────────────────────────────────────────────*/

test("no tools exposed means no tool transport at all", () => {
  for (const declaredNative of [true, false]) {
    assert.equal(negotiateTransport({ toolCount: 0, declaredNative }), "none");
  }
});

test("the declared flag decides the FIRST turn, in both directions", () => {
  assert.equal(negotiateTransport({ toolCount: 5, declaredNative: true }), "native");
  // The change that matters: `supportsTools: false` no longer means "no tools" — it means
  // "ask in text". `orchestration/backends.ts` hard-codes false for own-key cloud, which used
  // to remove the agent entirely.
  assert.equal(negotiateTransport({ toolCount: 5, declaredNative: false }), "text");
});

/* ── learning ────────────────────────────────────────────────────────────────*/

test("an endpoint that REFUSED tools is never asked natively again", () => {
  const state = observeTurn(initialCapability(), {
    transport: "native",
    nativeCalls: 0,
    textCalls: 0,
    rejectedForTools: true,
  });
  assert.equal(negotiateTransport({ toolCount: 5, declaredNative: true, observed: state }), "text");
});

test("a model that answers natively-offered tools with TEXT calls is demoted — after two", () => {
  let state = initialCapability();
  const turn = { transport: "native" as const, nativeCalls: 0, textCalls: 1 };

  state = observeTurn(state, turn);
  assert.equal(
    negotiateTransport({ toolCount: 5, declaredNative: true, observed: state }),
    "native",
    "one stray text call demoted the endpoint — a capable model would lose the better channel",
  );

  state = observeTurn(state, turn);
  assert.equal(state.textCallsWhileNative, TEXT_FALLBACK_THRESHOLD);
  assert.equal(negotiateTransport({ toolCount: 5, declaredNative: true, observed: state }), "text");
});

test("a single successful native call clears the strikes", () => {
  // Otherwise a long session slowly demotes a working endpoint one stray turn at a time.
  let state = observeTurn(initialCapability(), {
    transport: "native",
    nativeCalls: 0,
    textCalls: 1,
  });
  state = observeTurn(state, { transport: "native", nativeCalls: 1, textCalls: 0 });
  assert.equal(state.textCallsWhileNative, 0);
  assert.equal(state.nativeCalls, 1);
});

test("proven native support outranks a `false` declaration", () => {
  // The cloud-backend case: declared false, observed working. Believe the observation.
  const state: ToolCapabilityState = { ...initialCapability(), nativeCalls: 3 };
  assert.equal(
    negotiateTransport({ toolCount: 5, declaredNative: false, observed: state }),
    "native",
  );
});

test("a rejection outranks even proven native calls", () => {
  // Model swapped behind the same endpoint id. The refusal is the newer, harder fact.
  const state: ToolCapabilityState = {
    ...initialCapability(),
    nativeCalls: 9,
    nativeRejected: true,
  };
  assert.equal(negotiateTransport({ toolCount: 5, declaredNative: true, observed: state }), "text");
});

test("text calls on a TEXT turn are not strikes — that is the transport working", () => {
  const state = observeTurn(initialCapability(), {
    transport: "text",
    nativeCalls: 0,
    textCalls: 4,
  });
  assert.equal(state.textCallsWhileNative, 0);
});

/* ── recognising a rejection ─────────────────────────────────────────────────*/

test("a tools-specific client error is a rejection", () => {
  for (const body of [
    '{"error":{"message":"this model does not support tools"}}',
    "registry.ollama.ai: template does not support tools",
    '{"error":{"message":"Unrecognized request argument supplied: tools"}}',
    "Unsupported parameter: 'tools' is not supported with this model.",
  ]) {
    assert.equal(looksLikeToolsRejection(400, body), true, `missed: ${body}`);
  }
});

test("an UNRELATED 400 does not demote the endpoint", () => {
  // A context overflow or a bad temperature has nothing to do with tool support, and treating
  // it as proof would strand a capable model on the text protocol for the whole session.
  for (const body of [
    '{"error":{"message":"maximum context length is 8192 tokens"}}',
    '{"error":{"message":"temperature must be between 0 and 2"}}',
    "invalid api key",
  ]) {
    assert.equal(looksLikeToolsRejection(400, body), false, `false positive: ${body}`);
  }
});

test("a 5xx is never a capability signal", () => {
  // The server fell over; it said nothing about what the model can do.
  assert.equal(looksLikeToolsRejection(503, "this model does not support tools"), false);
  assert.equal(looksLikeToolsRejection(200, "does not support tools"), false);
});

/* ── preamble pairing ────────────────────────────────────────────────────────*/

test("only the text transport teaches the call syntax", () => {
  assert.equal(preambleModeFor("text"), "text");
  assert.equal(preambleModeFor("native"), "native");
  assert.equal(preambleModeFor("none"), "native");
});
