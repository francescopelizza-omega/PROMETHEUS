import assert from "node:assert/strict";
/**
 * env-store.test.ts — the framework-free env/package lifecycle (file 04 §7,§9).
 *
 * Covers: EVERY state-machine edge in the §9 diagram (plus the no-op totality of
 * illegal events), the §9 gate-block TERMINAL-state guarantee, the selectors
 * (selected env, package rows, rows-by-state), the §7 CUDA-aware torch
 * resolution (CPU vs cuXXX index), template→spec building (versions/extras/
 * optional gating), and the §6 batched-gate-plan shape.
 */
import { test } from "node:test";

import type { CudaInfo, Env, Package } from "./domain/models.js";
import {
  type EnvStoreState,
  type PackageRow,
  type PkgEvent,
  type PkgState,
  type Template,
  batchedGatePlan,
  canTransition,
  initialEnvStoreState,
  isBlockedTerminal,
  legalEvents,
  pkgTransition,
  selectPackageRows,
  selectRowsByState,
  selectSelectedEnv,
  templateResolve,
  torchCudaIndex,
} from "./env-store.js";

// ── §9 state machine: every edge in the diagram ───────────────────────────── //

const EDGES: ReadonlyArray<[PkgState, PkgEvent, PkgState]> = [
  // absent → pending (install / template)
  ["absent", "install", "pending"],
  ["absent", "template", "pending"],
  // pending → installed (gate clean) / blocked (gate block)
  ["pending", "gateClean", "installed"],
  ["pending", "gateBlock", "blocked"],
  // pending can be cancelled back to absent
  ["pending", "remove", "absent"],
  ["pending", "uninstall", "absent"],
  // installed → pending (update/upgrade), outdated (passive), disabled, absent
  ["installed", "update", "pending"],
  ["installed", "upgrade", "pending"],
  ["installed", "markOutdated", "outdated"],
  ["installed", "disable", "disabled"],
  ["installed", "remove", "absent"],
  ["installed", "uninstall", "absent"],
  // enabled alias behaves like installed
  ["enabled", "update", "pending"],
  ["enabled", "disable", "disabled"],
  ["enabled", "remove", "absent"],
  ["enabled", "uninstall", "absent"],
  ["enabled", "markOutdated", "outdated"],
  ["enabled", "upgrade", "pending"],
  // outdated → pending (update/upgrade), disabled, absent
  ["outdated", "update", "pending"],
  ["outdated", "upgrade", "pending"],
  ["outdated", "disable", "disabled"],
  ["outdated", "remove", "absent"],
  ["outdated", "uninstall", "absent"],
  // disabled → pending (enable re-gates), absent
  ["disabled", "enable", "pending"],
  ["disabled", "remove", "absent"],
  ["disabled", "uninstall", "absent"],
  // blocked (terminal) → pending (rescan), installed (force), absent
  ["blocked", "rescan", "pending"],
  ["blocked", "forceInstall", "installed"],
  ["blocked", "remove", "absent"],
  ["blocked", "uninstall", "absent"],
];

test("§9 every documented edge transitions exactly as drawn", () => {
  for (const [from, event, to] of EDGES) {
    assert.equal(
      pkgTransition(from, event),
      to,
      `expected ${from} --${event}--> ${to}, got ${pkgTransition(from, event)}`,
    );
    assert.equal(canTransition(from, event), true, `${from} --${event}--> should be legal`);
  }
});

test("illegal events are NO-OPs (the table is total, never throws)", () => {
  // gateClean is meaningless on an absent row → stays absent.
  assert.equal(pkgTransition("absent", "gateClean"), "absent");
  // you cannot disable something that is absent.
  assert.equal(pkgTransition("absent", "disable"), "absent");
  // installed has no rescan edge (only blocked does).
  assert.equal(pkgTransition("installed", "rescan"), "installed");
  // forceInstall is only valid out of blocked.
  assert.equal(pkgTransition("installed", "forceInstall"), "installed");
  assert.equal(canTransition("absent", "gateClean"), false);
});

test("§9 GATE-BLOCK is terminal: a blocked row never decays toward installed", () => {
  assert.equal(isBlockedTerminal("blocked"), true);
  assert.equal(isBlockedTerminal("installed"), false);

  // The ONLY events that leave `blocked` are rescan / forceInstall / remove / uninstall.
  const escapes = legalEvents("blocked").sort();
  assert.deepEqual(escapes, ["forceInstall", "remove", "rescan", "uninstall"].sort());

  // No passive/optimistic event can flip blocked → installed.
  for (const ev of ["install", "template", "gateClean", "update", "enable"] as PkgEvent[]) {
    assert.equal(
      pkgTransition("blocked", ev),
      "blocked",
      `blocked must absorb ${ev} (stay blocked)`,
    );
  }
  // The deliberate, security-authorised force override is the documented escape.
  assert.equal(pkgTransition("blocked", "forceInstall"), "installed");
  // A fresh re-scan re-enters the gate (pending), not installed directly.
  assert.equal(pkgTransition("blocked", "rescan"), "pending");
});

test("a clean install path: absent → pending → installed", () => {
  let s: PkgState = "absent";
  s = pkgTransition(s, "install");
  assert.equal(s, "pending");
  s = pkgTransition(s, "gateClean");
  assert.equal(s, "installed");
});

test("a blocked install path: absent → pending → blocked (refused)", () => {
  let s: PkgState = "absent";
  s = pkgTransition(s, "install");
  s = pkgTransition(s, "gateBlock");
  assert.equal(s, "blocked");
  assert.equal(isBlockedTerminal(s), true);
});

// ── selectors ─────────────────────────────────────────────────────────────── //

function env(path: string, name = path): Env {
  return { name, path, kind: "venv", pythonVersion: "3.11.9", packagesCount: 0 };
}
function pkgRow(name: string, state: PkgState, version = "1.0.0"): PackageRow {
  const pkg: Package = { name, version };
  return { pkg, state };
}

test("selectors: selected env, package rows, rows-by-state", () => {
  const a = env("/envs/a");
  const b = env("/envs/b");
  const rows: PackageRow[] = [
    pkgRow("torch", "installed"),
    pkgRow("transformers", "outdated"),
    pkgRow("bad-pkg", "blocked"),
  ];
  const s: EnvStoreState = {
    envs: [a, b],
    selectedEnvPath: "/envs/a",
    packages: { "/envs/a": rows },
  };

  assert.equal(selectSelectedEnv(s)?.path, "/envs/a");
  assert.equal(selectPackageRows(s).length, 3);
  assert.equal(selectRowsByState(s, "outdated").length, 1);
  assert.equal(selectRowsByState(s, "blocked")[0]?.pkg.name, "bad-pkg");

  // nothing selected → null env, empty rows.
  const empty = initialEnvStoreState();
  assert.equal(selectSelectedEnv(empty), null);
  assert.deepEqual(selectPackageRows(empty), []);

  // selected path with no package map entry → empty rows (no crash).
  assert.deepEqual(selectPackageRows({ ...s, selectedEnvPath: "/envs/b" }), []);
  // selected path not in envs[] → null env.
  assert.equal(selectSelectedEnv({ ...s, selectedEnvPath: "/nope" }), null);
});

// ── §7 CUDA-aware torch resolution ────────────────────────────────────────── //

const TORCH_TEMPLATE: Template = {
  id: "t",
  title: "T",
  description: "torch only",
  packages: [{ name: "torch", source: "pypi", requestedBy: "template" }],
  editable: true,
  builtin: true,
};

function cuda(p: Partial<CudaInfo>): CudaInfo {
  return {
    gpu: null,
    driver: null,
    cudaVersion: null,
    nvidiaSmi: false,
    nvcc: false,
    torchCuda: null,
    available: false,
    ...p,
  };
}

test("torchCudaIndex: CPU vs CUDA runtime → correct wheel line", () => {
  assert.equal(torchCudaIndex(null), undefined, "no GPU → CPU build, no index");
  assert.equal(torchCudaIndex(cuda({ available: false })), undefined);
  assert.equal(
    torchCudaIndex(cuda({ available: true, cudaVersion: "12.4" })),
    "https://download.pytorch.org/whl/cu121",
  );
  assert.equal(
    torchCudaIndex(cuda({ available: true, cudaVersion: "11.8" })),
    "https://download.pytorch.org/whl/cu118",
  );
  // CUDA present but version unparseable → conservative default line (still pinned).
  assert.equal(
    torchCudaIndex(cuda({ available: true, cudaVersion: "" })),
    "https://download.pytorch.org/whl/cu121",
  );
});

test("§7 templateResolve: torch is CPU on a CPU host, cuXXX on a GPU host", () => {
  const cpu = templateResolve(TORCH_TEMPLATE, null);
  assert.equal(cpu.length, 1);
  assert.equal(cpu[0]?.name, "torch");
  assert.equal(cpu[0]?.spec, "torch");
  assert.equal(cpu[0]?.indexUrl, undefined, "CPU host → no CUDA index");
  assert.equal(cpu[0]?.source, "pypi");

  const gpu = templateResolve(TORCH_TEMPLATE, cuda({ available: true, cudaVersion: "12.4" }));
  assert.equal(gpu[0]?.indexUrl, "https://download.pytorch.org/whl/cu121");
  assert.equal(gpu[0]?.source, "cuda", "a CUDA-matched torch wheel is sourced as cuda");
});

test("§7 templateResolve: versions, extras, and optional gating", () => {
  const tpl: Template = {
    id: "x",
    title: "X",
    description: "",
    packages: [
      { name: "transformers", version: ">=4.40", source: "pypi" },
      { name: "numpy", version: "1.26.4", source: "pypi" }, // bare version → ==
      { name: "uvicorn", extras: ["standard"], source: "pypi" },
      { name: "flash-attn", optional: true, source: "pypi" }, // unchecked by default
    ],
    editable: true,
    builtin: true,
  };
  const def = templateResolve(tpl);
  assert.equal(def.length, 3, "optional rows excluded by default");
  assert.equal(def.find((r) => r.name === "transformers")?.spec, "transformers>=4.40");
  assert.equal(def.find((r) => r.name === "numpy")?.spec, "numpy==1.26.4");
  assert.equal(def.find((r) => r.name === "uvicorn")?.spec, "uvicorn[standard]");
  assert.equal(
    def.find((r) => r.name === "flash-attn"),
    undefined,
    "optional excluded unless opted in",
  );

  const withOpt = templateResolve(tpl, null, { includeOptional: true });
  assert.equal(withOpt.length, 4);
  assert.equal(withOpt.find((r) => r.name === "flash-attn")?.optional, true);
});

// ── §6 batched gate plan ──────────────────────────────────────────────────── //

test("§6 batchedGatePlan: shape + count + carries index/optional", () => {
  const specs = templateResolve(
    {
      id: "p",
      title: "P",
      description: "",
      packages: [
        { name: "torch", source: "pypi" },
        { name: "flash-attn", optional: true, source: "pypi" },
      ],
      editable: true,
      builtin: true,
    },
    cuda({ available: true, cudaVersion: "12.1" }),
    { includeOptional: true },
  );
  const plan = batchedGatePlan(specs);
  assert.equal(plan.count, 2);
  assert.equal(plan.items.length, 2);
  const torch = plan.items.find((i) => i.name === "torch");
  assert.equal(torch?.indexUrl, "https://download.pytorch.org/whl/cu121");
  const fa = plan.items.find((i) => i.name === "flash-attn");
  assert.equal(fa?.optional, true);
  // a CPU plan omits indexUrl entirely.
  const cpuPlan = batchedGatePlan(templateResolve(TORCH_TEMPLATE, null));
  assert.equal(cpuPlan.items[0] && "indexUrl" in cpuPlan.items[0], false);
});
