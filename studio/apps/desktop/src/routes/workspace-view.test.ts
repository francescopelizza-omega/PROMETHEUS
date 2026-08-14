/**
 * workspace-view.test.ts — the §5 view model.
 *
 * The assertion that matters most: a repo whose tree moved since its last scan must NOT read
 * as `scanned ✓`, whatever that last verdict said. That window is exactly where a rug-pull
 * lands, and "allow, but from before the change" rendered as a green tick is the single most
 * misleading thing this row could say.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { cellVar, docRows, envAction, envRow, repoScan, repoSync } from "./workspace-view.js";

/* ── repos ───────────────────────────────────────────────────────────────────*/

test("a STALE tree is never `scanned ✓`, even on a prior allow", () => {
  const r = repoScan({ status: "stale", lastVerdict: { verdict: "allow" } });
  assert.equal(r.text, "stale scan");
  assert.equal(r.role, "warn");
});

test("quarantined or blocked outranks everything else", () => {
  assert.equal(repoScan({ status: "quarantined" }).text, "blocked");
  assert.equal(repoScan({ status: "live", lastVerdict: { verdict: "block" } }).text, "blocked");
  assert.equal(repoScan({ status: "live", lastVerdict: { verdict: "block" } }).role, "danger");
});

test("a never-scanned repo says so — it does not borrow a neighbour's verdict", () => {
  const r = repoScan({ status: "live" });
  assert.equal(r.text, "unscanned");
  assert.equal(r.role, "muted");
});

test("warn and allow each get their own mark", () => {
  assert.equal(repoScan({ status: "live", lastVerdict: { verdict: "warn" } }).text, "scanned ▲");
  assert.equal(repoScan({ status: "live", lastVerdict: { verdict: "allow" } }).text, "scanned ✓");
});

test("the sync cell never claims a divergence nothing measured", () => {
  // §5's example is `↑2 · clean`, but no ahead/behind count exists in the repo contract.
  // Reporting "clean" unmeasured is the claim a user would pull on.
  assert.equal(repoSync({ status: "live", pinnedCommit: "abc123" }).text, "pinned");
  assert.equal(repoSync({ status: "live" }).text, "never fetched");
  assert.equal(
    repoSync({ status: "live", lastFetched: "2026-08-01", commit: "0123456789" }).text,
    "fetched 0123456",
  );
  for (const cell of [
    repoSync({ status: "live" }),
    repoSync({ status: "live", lastFetched: "2026-08-01" }),
  ]) {
    assert.doesNotMatch(cell.text, /clean/, "the row claimed a cleanliness it never measured");
  }
});

/* ── environments ────────────────────────────────────────────────────────────*/

test("the detail line is assembled only from fields that came back", () => {
  // "0 packages" would read as an EMPTY environment; a missing count is not a count of zero.
  assert.equal(envRow({ id: "e", pythonVersion: "3.12" }).detail, "python 3.12");
  assert.equal(
    envRow({ id: "e", pythonVersion: "3.12", packageCount: 84, kind: "venv" }).detail,
    "python 3.12 · 84 packages · venv",
  );
  assert.equal(envRow({ id: "e" }).detail, "");
});

test("a package ARRAY is counted when no explicit count is given", () => {
  assert.equal(envRow({ id: "e", packages: ["a", "b"] }).detail, "2 packages");
  assert.equal(envRow({ id: "e", packages: ["a"] }).detail, "1 package");
});

test("broken outranks active, and drives the Recreate action", () => {
  const broken = envRow({ id: "e", active: true, broken: true });
  assert.equal(broken.status.text, "broken");
  assert.equal(broken.status.role, "danger");
  assert.equal(envAction(broken), "Recreate");
  assert.equal(envAction(envRow({ id: "e", active: true })), "Inspect");
  assert.equal(envAction(envRow({ id: "e" })), "Activate");
});

test("an id falls back through name and path rather than rendering an empty row", () => {
  assert.equal(envRow({ name: "proj" }).id, "proj");
  assert.equal(envRow({ path: "/envs/x" }).id, "/envs/x");
});

/* ── docs ────────────────────────────────────────────────────────────────────*/

const ROOT = "/repo";

test("only document extensions are listed", () => {
  const rows = docRows(
    [`${ROOT}/README.md`, `${ROOT}/src/index.ts`, `${ROOT}/docs/guide.mdx`, `${ROOT}/a.png`],
    ROOT,
  );
  assert.deepEqual(
    rows.map((r) => r.filename),
    ["guide.mdx", "README.md"],
  );
});

test("rows sort by FILENAME so same-named docs group together", () => {
  // Sorting by path buries the top-level README under whichever package sorts first.
  const rows = docRows(
    [`${ROOT}/packages/z/README.md`, `${ROOT}/CHANGELOG.md`, `${ROOT}/packages/a/README.md`],
    ROOT,
  );
  assert.deepEqual(
    rows.map((r) => `${r.dir}/${r.filename}`),
    ["./CHANGELOG.md", "packages/a/README.md", "packages/z/README.md"],
  );
});

test("the directory is relative to the root; a root-level file reports `.`", () => {
  const [top, nested] = docRows([`${ROOT}/README.md`, `${ROOT}/docs/x/y.md`], ROOT);
  assert.equal(top?.dir, ".");
  assert.equal(nested?.dir, "docs/x");
  assert.equal(nested?.path, `${ROOT}/docs/x/y.md`, "the absolute path is kept for opening");
});

test("a path outside the root keeps its full path rather than being mangled", () => {
  const [row] = docRows(["/elsewhere/NOTES.md"], ROOT);
  assert.equal(row?.dir, "/elsewhere");
  assert.equal(row?.filename, "NOTES.md");
});

test("the limit caps the list", () => {
  const many = Array.from({ length: 50 }, (_, i) => `${ROOT}/d${i}.md`);
  assert.equal(docRows(many, ROOT, 10).length, 10);
});

/* ── roles ───────────────────────────────────────────────────────────────────*/

test("every role resolves to a token, never a hex", () => {
  for (const role of ["ok", "warn", "danger", "muted"] as const) {
    assert.match(cellVar(role), /^var\(--/);
  }
});
