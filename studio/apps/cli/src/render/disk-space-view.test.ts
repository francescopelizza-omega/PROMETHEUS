// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import test from "node:test";
import type {
  DiskCleanupFinding,
  DiskDeleteResult,
  DiskMount,
  DiskTreeNode,
} from "@prometheus/engine-bridge";
import { setColorEnabled } from "../render.js";
import {
  bar,
  renderCleanup,
  renderDeletePlan,
  renderFiles,
  renderLevels,
  renderMounts,
  renderTree,
} from "./disk-space-view.js";

setColorEnabled(false);

const GB = 1024 ** 3;
const TREE: DiskTreeNode = {
  name: "/data",
  path: "/data",
  size: 10 * GB,
  dir: true,
  children: [
    {
      name: "videos",
      path: "/data/videos",
      size: 6 * GB,
      dir: true,
      items: 120,
      children: [{ name: "raw", path: "/data/videos/raw", size: 5 * GB, dir: true }],
    },
    { name: "docs", path: "/data/docs", size: 3 * GB, dir: true, items: 4000, unreadable: true },
    { name: "mnt", path: "/data/mnt", size: 1 * GB, dir: true, mount: true },
  ],
  more: 2,
};

test("bar: proportional, fixed width, never overflows", () => {
  assert.equal(bar(0.5, 10), "█████░░░░░");
  assert.equal(bar(0, 4), "░░░░");
  assert.equal(bar(2, 4), "████");
  assert.equal(bar(Number.NaN, 4), "░░░░");
});

test("tree: size, %, bar and items columns, biggest first, nested one level", () => {
  const out = renderTree(TREE, { depth: 2 }).join("\n");
  assert.match(out, /\/data\s+10 GB/);
  assert.match(out, /6\.0 GB\s+60\.0%\s+█/);
  assert.match(out, /120\s+videos/);
  assert.match(out, /raw/);
  assert.ok(out.indexOf("videos") < out.indexOf("docs"));
  assert.match(out, /docs.*unreadable/);
  assert.match(out, /mnt.*other filesystem/);
  assert.match(out, /2 more/);
});

test("mounts: target, type, size, used, free and a use bar", () => {
  const m: DiskMount = {
    source: "/dev/disk3s1",
    target: "/",
    fstype: "apfs",
    total: 100 * GB,
    used: 75 * GB,
    free: 25 * GB,
    usePct: 75,
  };
  const out = renderMounts([m]).join("\n");
  assert.match(out, /\/\s+apfs\s+100 GB\s+75 GB\s+25 GB\s+75%/);
  assert.match(out, /███/);
});

test("levels and files list biggest first", () => {
  const lv = renderLevels([
    {
      depth: 1,
      rows: [
        { path: "/a", size: 2 * GB },
        { path: "/b", size: GB },
      ],
    },
  ]).join("\n");
  assert.match(lv, /depth 1/);
  assert.ok(lv.indexOf("/a") < lv.indexOf("/b"));
  const files = renderFiles([{ path: "/x/big.iso", size: 4 * GB, mtime: 0 }]).join("\n");
  assert.match(files, /4\.0 GB\s+\/x\/big\.iso/);
});

test("a delete plan shows mode, risk and the protected reason, and says nothing changed", () => {
  const plan: DiskDeleteResult = {
    ok: true,
    command: "disk.delete",
    planned: true,
    mode: "trash",
    items: [
      {
        path: "/data/cache",
        mode: "trash",
        size: GB,
        risk: "LOW",
        reason: "cache",
        protected: null,
      },
      { path: "/", mode: "trash", size: 0, risk: null, reason: "", protected: "system folder" },
    ],
    worstRisk: "LOW",
    total: GB,
    requiresPhrase: false,
  };
  const out = renderDeletePlan(plan).join("\n");
  assert.match(out, /move to Trash/);
  assert.match(out, /LOW\s+1\.0 GB\s+\/data\/cache/);
  assert.match(out, /REFUSED.*system folder/);
  assert.match(out, /nothing has been changed/);
});

test("cleanup lists findings and numbers the actions that can run", () => {
  const f: DiskCleanupFinding = {
    id: "docker",
    title: "Docker",
    category: "containers",
    size: 5 * GB,
    reclaimable: 2 * GB,
    mountpoint: "/",
    risk: "LOW",
    summary: "images and build cache",
    actions: [
      {
        id: "prune-safe",
        title: "Prune unused data",
        risk: "LOW",
        needsRoot: true,
        needsInput: [],
        preview: ["$ docker system prune -f"],
        requiresReboot: false,
        recommended: true,
        command: ["python3", "disk_space.py", "--apply", "docker:prune-safe"],
      },
    ],
  };
  const out = renderCleanup([f]).join("\n");
  assert.match(out, /Docker.*2\.0 GB reclaimable/);
  assert.match(out, /1\)\s+Prune unused data.*root/);
  assert.match(out, /\$ docker system prune -f/);
});
