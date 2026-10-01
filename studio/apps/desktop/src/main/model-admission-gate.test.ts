// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * model-admission-gate.test.ts — the desktop's memory gate.
 *
 * Every probe is injected, so this suite spawns nothing and reaches no daemon.
 *
 * The assertions are weighted toward FALSE REFUSALS, because that is how this change makes
 * things worse rather than better: the app worked before, with no gate at all, so a gate that
 * refuses a legitimate load is a pure regression. The idle-LM-Studio case below is not
 * hypothetical — it is the defect an adversarial review caught before this shipped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  admissionCheckCount,
  admitDesktopModelLoad,
  resetAdmissionCache,
} from "./model-admission-gate.js";

const GB = 1024 ** 3;

/** A machine with `availGb` free of 64 GB. */
const mem =
  (availGb: number) =>
  async (): Promise<{
    totalBytes: number;
    availableBytes: number;
    headroomBytes: number;
    source: string;
  }> => ({
    totalBytes: 64 * GB,
    availableBytes: availGb * GB,
    headroomBytes: 2 * GB,
    source: "measured",
  });

const noCensus = async (): Promise<[]> => [];

/** One installed model of `weightsGb`, as `inventoryCandidates` would report it. */
const inventory =
  (id: string, weightsGb: number) => async (): Promise<Array<Record<string, unknown>>> => [
    { id, weightsBytes: weightsGb * GB, contextTokens: 8192, runner: "ollama", geometry: null },
  ];

function deps(o: Record<string, unknown>): never {
  return o as never;
}

test("a model that comfortably fits is allowed", async () => {
  resetAdmissionCache();
  const r = await admitDesktopModelLoad(
    "http://localhost:11434/v1",
    "small:latest",
    8192,
    deps({ memoryFn: mem(48), censusFn: noCensus, inventoryFn: inventory("small:latest", 4) }),
  );
  assert.equal(r.allow, true);
  assert.deepEqual(r.lines, []);
});

test("a model far larger than free memory is refused, with a usable reason", async () => {
  resetAdmissionCache();
  const r = await admitDesktopModelLoad(
    "http://localhost:11434/v1",
    "huge:latest",
    8192,
    deps({ memoryFn: mem(4), censusFn: noCensus, inventoryFn: inventory("huge:latest", 40) }),
  );
  assert.equal(r.allow, false);
  assert.ok(r.lines.length > 0, "a refusal must carry prose the user can act on");
});

/* ── false refusals: the ways this change could make things worse ─────────── */

test("an IDLE LM Studio does not block a load — the lockout this gate nearly shipped", async () => {
  // `parseOpenAiModels` returns LM Studio's CATALOGUE with sizeBytes:0, and the one-server rule
  // used to count `models.length > 0`. With a real gate that meant: LM Studio open ⇒ every chat
  // refused, forever, on a machine holding nothing. Core now carries `residencyKnown`.
  resetAdmissionCache();
  const idleCatalogue = async (): Promise<Array<Record<string, unknown>>> => [
    {
      runner: "lmstudio",
      baseUrl: "http://localhost:1234",
      up: true,
      residencyKnown: false,
      models: [
        { id: "qwen2.5-7b", sizeBytes: 0 },
        { id: "llama-3.1-8b", sizeBytes: 0 },
      ],
    },
  ];
  const r = await admitDesktopModelLoad(
    "http://localhost:11434/v1",
    "small:latest",
    8192,
    deps({
      memoryFn: mem(48),
      censusFn: idleCatalogue,
      inventoryFn: inventory("small:latest", 4),
    }),
  );
  assert.equal(r.allow, true, "a catalogue is not residency");
});

test("a model that is not installed here is allowed — nothing to weigh, nothing to refuse", async () => {
  resetAdmissionCache();
  const r = await admitDesktopModelLoad(
    "http://localhost:11434/v1",
    "not-installed:latest",
    8192,
    deps({ memoryFn: mem(2), censusFn: noCensus, inventoryFn: inventory("other:latest", 40) }),
  );
  assert.equal(r.allow, true);
});

test("a model reporting zero weight bytes is allowed, not refused as infinitely large", async () => {
  resetAdmissionCache();
  const r = await admitDesktopModelLoad(
    "http://localhost:11434/v1",
    "unknown:latest",
    8192,
    deps({ memoryFn: mem(2), censusFn: noCensus, inventoryFn: inventory("unknown:latest", 0) }),
  );
  assert.equal(r.allow, true);
});

test("EVERY probe failure fails OPEN — the gate never becomes the reason a turn cannot run", async () => {
  const boom = async (): Promise<never> => {
    throw new Error("probe exploded");
  };
  for (const broken of ["memoryFn", "censusFn", "inventoryFn"]) {
    resetAdmissionCache();
    const d: Record<string, unknown> = {
      memoryFn: mem(48),
      censusFn: noCensus,
      inventoryFn: inventory("small:latest", 4),
    };
    d[broken] = boom;
    const r = await admitDesktopModelLoad(
      "http://localhost:11434/v1",
      "small:latest",
      8192,
      deps(d),
    );
    assert.equal(r.allow, true, `${broken} threw and the gate refused — must fail open`);
  }
});

/* ── cost discipline ──────────────────────────────────────────────────────── */

test("the verdict is cached per (endpoint, model) — no process spawn per turn", async () => {
  // The gate costs a sysctl spawn plus two HTTP probes. Running it on every message would put
  // a process spawn in the hot path of a conversation.
  resetAdmissionCache();
  const before = admissionCheckCount();
  const d = deps({
    memoryFn: mem(48),
    censusFn: noCensus,
    inventoryFn: inventory("small:latest", 4),
  });
  for (let i = 0; i < 5; i += 1) {
    await admitDesktopModelLoad("http://localhost:11434/v1", "small:latest", 8192, d);
  }
  assert.equal(admissionCheckCount() - before, 1, "five turns, one check");
});

test("a DIFFERENT model is checked again — the cache is keyed, not global", async () => {
  resetAdmissionCache();
  const before = admissionCheckCount();
  const d = deps({
    memoryFn: mem(48),
    censusFn: noCensus,
    inventoryFn: inventory("small:latest", 4),
  });
  await admitDesktopModelLoad("http://localhost:11434/v1", "small:latest", 8192, d);
  await admitDesktopModelLoad("http://localhost:11434/v1", "other:latest", 8192, d);
  await admitDesktopModelLoad("http://localhost:11435/v1", "small:latest", 8192, d);
  assert.equal(admissionCheckCount() - before, 3);
});
