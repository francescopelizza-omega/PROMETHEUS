/**
 * exception-breakpoints.test.ts — node:test for the PURE exception-filter model (APP-079).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IdeDapExceptionFilter } from "../../../shared/ipc-contract.js";
import {
  defaultExceptionFilters,
  isExceptionFilterEnabled,
  pruneExceptionFilters,
  toggleExceptionFilter,
  useExceptionFilterStore,
} from "./exception-breakpoints.js";

const FILTERS: IdeDapExceptionFilter[] = [
  { filter: "raised", label: "Raised Exceptions" },
  { filter: "uncaught", label: "Uncaught Exceptions", default: true },
];

test("defaultExceptionFilters returns only the adapter's default:true filters, sorted", () => {
  assert.deepEqual(defaultExceptionFilters(FILTERS), ["uncaught"]);
  assert.deepEqual(defaultExceptionFilters([]), []);
});

test("toggleExceptionFilter arms/disarms; sorted + de-duped; same-ref no-op when unchanged", () => {
  let e: string[] = [];
  e = toggleExceptionFilter(e, "uncaught", true);
  assert.deepEqual(e, ["uncaught"]);
  const same = toggleExceptionFilter(e, "uncaught", true); // already on
  assert.equal(same, e);
  e = toggleExceptionFilter(e, "raised", true);
  assert.deepEqual(e, ["raised", "uncaught"]); // sorted
  e = toggleExceptionFilter(e, "uncaught", false);
  assert.deepEqual(e, ["raised"]);
  assert.equal(toggleExceptionFilter(e, "nope", false), e); // absent-off no-op
});

test("isExceptionFilterEnabled reflects membership", () => {
  assert.equal(isExceptionFilterEnabled(["uncaught"], "uncaught"), true);
  assert.equal(isExceptionFilterEnabled(["uncaught"], "raised"), false);
});

test("pruneExceptionFilters drops ids the adapter no longer advertises (same-ref when clean)", () => {
  assert.deepEqual(pruneExceptionFilters(["raised", "gone"], FILTERS), ["raised"]);
  const clean = ["uncaught"];
  assert.equal(pruneExceptionFilters(clean, FILTERS), clean);
});

test("store.seed arms the defaults ONCE, never clobbering a later user choice", () => {
  useExceptionFilterStore.setState({ enabled: [], seeded: false });
  useExceptionFilterStore.getState().seed(FILTERS);
  assert.deepEqual(useExceptionFilterStore.getState().enabled, ["uncaught"]);
  // a second seed is a no-op even after the user changed the set.
  useExceptionFilterStore.getState().toggle("raised", true);
  useExceptionFilterStore.getState().seed(FILTERS);
  assert.deepEqual(useExceptionFilterStore.getState().enabled, ["raised", "uncaught"]);
  useExceptionFilterStore.setState({ enabled: [], seeded: false });
});
