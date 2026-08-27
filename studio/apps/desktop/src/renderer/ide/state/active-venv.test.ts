/**
 * active-venv.test.ts — which env a new terminal inherits (§6.1's "load-bearing behaviour").
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { pickActiveVenv } from "./active-venv.js";

const ROOT = "/home/dev/project";

test("a conventional .venv inside the workspace is the one a terminal inherits", () => {
  const got = pickActiveVenv(ROOT, [
    { name: "other", path: "/home/dev/other/.venv" },
    { name: "project", path: `${ROOT}/.venv` },
  ]);
  assert.deepEqual(got, { root: `${ROOT}/.venv` });
});

test("an env OUTSIDE the workspace is never force-activated", () => {
  /**
   * An env registered elsewhere on the machine belongs to a different project. Activating it in
   * this project's terminals would put `python` and `pip install` in the wrong environment —
   * worse than the null this returns, which just leaves the shell unchanged.
   */
  assert.equal(
    pickActiveVenv(ROOT, [
      { name: "elsewhere", path: "/home/dev/other/.venv" },
      { name: "global", path: "/usr/local/pyenv/versions/3.12" },
    ]),
    null,
  );
  // a prefix that is not a path boundary must not count as "inside"
  assert.equal(
    pickActiveVenv(ROOT, [{ name: "sneaky", path: "/home/dev/project-other/.venv" }]),
    null,
  );
  // the workspace root itself is not an env inside it
  assert.equal(pickActiveVenv(ROOT, [{ name: "self", path: ROOT }]), null);
});

test("a non-conventional name inside the workspace still counts, and .venv wins over it", () => {
  assert.deepEqual(pickActiveVenv(ROOT, [{ name: "env", path: `${ROOT}/env` }]), {
    root: `${ROOT}/env`,
  });
  assert.deepEqual(
    pickActiveVenv(ROOT, [
      { name: "env", path: `${ROOT}/env` },
      { name: "dotvenv", path: `${ROOT}/.venv` },
    ]),
    { root: `${ROOT}/.venv` },
    "the conventional layout must be predictable when both exist",
  );
});

test("no envs, an empty root, and a trailing separator are all handled", () => {
  assert.equal(pickActiveVenv(ROOT, []), null);
  assert.equal(pickActiveVenv("", [{ name: "x", path: "/x/.venv" }]), null);
  assert.deepEqual(pickActiveVenv(`${ROOT}/`, [{ name: "p", path: `${ROOT}/.venv` }]), {
    root: `${ROOT}/.venv`,
  });
});

test("windows paths resolve on their own separator", () => {
  const win = "C:\\Users\\dev\\project";
  assert.deepEqual(pickActiveVenv(win, [{ name: "p", path: `${win}\\.venv` }]), {
    root: `${win}\\.venv`,
  });
  assert.equal(pickActiveVenv(win, [{ name: "o", path: "C:\\Users\\dev\\other\\.venv" }]), null);
});
