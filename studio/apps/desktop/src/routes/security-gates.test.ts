/**
 * security-gates.test.ts — the Security console's destructive actions keep their friction.
 *
 * handoff_3 §4, verbatim: "**Inspect** / **Delete** (danger-outline). Restore requires typed
 * confirm."
 *
 * Restore had none. `onRestore={(id) => void restoreFromVault(id)}` was one click, and
 * `onRestoreSelected` looped a whole selection through the same call with zero confirms —
 * so the multi-select path multiplied a missing gate by N. Purge, the irreversible action,
 * was correctly gated by `PurgeDialog` all along; restore is the one that lifts an artifact
 * nemesis refused back into the workspace, executable again, which is the state the gate
 * existed to prevent.
 *
 * These are SOURCE assertions on purpose. The defect is a wiring shape in a .tsx route, and
 * the confirm it is missing is a dialog — neither is visible to a unit test of the pure
 * console view, which is why the gap survived a green suite.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (): string => readFileSync(join(HERE, "security.tsx"), "utf8");

test("restore opens the typed confirm; it never calls the engine directly", () => {
  const s = src();
  assert.match(
    s,
    /onRestore=\{\(id\)\s*=>\s*\n?\s*setRestoreTarget\(/,
    "the single-item Restore button must arm the confirm, not restore",
  );
  assert.doesNotMatch(
    s,
    /onRestore=\{\(id\)\s*=>\s*void restoreFromVault\(/,
    "one-click restore is back",
  );
});

test("the bulk path confirms ONE item, exactly as purge does", () => {
  const s = src();
  assert.match(s, /onRestoreSelected=\{\(ids\)\s*=>\s*\{[\s\S]*?setRestoreTarget\(/);
  assert.doesNotMatch(
    s,
    /const restoreSelected = useCallback/,
    "the unconfirmed batch-restore loop is back — one confirm cannot stand for N items",
  );
  // and it must TELL the user the rest were not queued, rather than silently dropping them
  assert.match(s, /Restore confirms one item at a time/);
});

test("a PurgeDialog is actually mounted for the restore target", () => {
  const s = src();
  assert.match(
    s,
    /\{restoreTarget && \(\s*<PurgeDialog/,
    "armed state with no dialog would be a confirm that never appears",
  );
  // the dialog gates on the artifact's basename; the host must pass the real path
  assert.match(s, /filename=\{restoreTarget\.path\}/);
  assert.match(s, /onConfirm=\{\(typed\) => void restoreFromVault\(restoreTarget, typed\)\}/);
});

test("the SECOND vault — URL-audit re-trust — is gated too", () => {
  // An adversarial pass found this one: the §4 rule had been applied to the nemesis vault
  // and not to the URL-audit vault in the same file, where `Restore (re-trust)` fired
  // `security.urlAudit({op:"restore"})` on a single click — no dialog, no typed name — and
  // main accepted it on a bare non-empty string.
  const s = src();
  assert.match(
    s,
    /onClick=\{\(\) => setUrlRestoreTarget\(/,
    "one-click re-trust of a quarantined origin is back",
  );
  assert.doesNotMatch(s, /onClick=\{\(\) => void restoreQuarantined\(/);
  assert.match(s, /\{urlRestoreTarget && \(\s*<PurgeDialog/, "armed state with no dialog");
  assert.match(s, /onConfirm=\{\(\) => void restoreQuarantined\(urlRestoreTarget\.vault\)\}/);
});

test("BOTH vaults clear their arming before the engine call", () => {
  // otherwise a second click while the first is in flight re-fires the same restore
  const s = src();
  assert.match(s, /setRestoreTarget\(null\);/);
  assert.match(s, /setUrlRestoreTarget\(null\);/);
});

test("purge keeps its own typed confirm — this change must not have moved it", () => {
  const s = src();
  assert.match(s, /\{purgeTarget && \(\s*<PurgeDialog/);
  assert.match(s, /onConfirm=\{\(typed\)\s*=>\s*void purgeFromVault\(purgeTarget, typed\)\}/);
});

test("restore's confirm is ENFORCED in main, not only drawn in the renderer", () => {
  // Purge was gated in three places; restore had a dialog and nothing else. A renderer bug
  // that armed a target and called through reinstated an artifact the gate had refused.
  const ipc = readFileSync(join(HERE, "..", "main", "security-ipc.ts"), "utf8");
  assert.match(
    ipc,
    /if \(a\.typedName !== purgeBasename\(a\.path \?\? a\.id\)\) \{/,
    "main no longer re-checks the restore confirm",
  );
  assert.match(ipc, /op: "restore",\s*\n\s*error: "restore refused/);
});

test("the renderer actually SENDS the typed string and the path", () => {
  // A main-process check that the renderer never feeds is a check that always refuses.
  const s = src();
  assert.match(s, /op: "restore",[\s\S]{0,120}typedName,[\s\S]{0,40}path,/);
  assert.match(s, /onConfirm=\{\(typed\) => void restoreFromVault\(restoreTarget, typed\)\}/);
});

test("the no-vault bail happens BEFORE the dialog is dismissed", () => {
  // the old order made the user type a full basename and only then said "load a vault first"
  const s = src();
  const fn = /const restoreFromVault = useCallback\([\s\S]*?\n {2}\);/.exec(s)?.[0] ?? "";
  assert.ok(fn, "restoreFromVault not found");
  assert.ok(
    fn.indexOf("load a vault first") < fn.indexOf("setRestoreTarget(null)"),
    "the confirm is dismissed before the precondition is checked",
  );
});

test("the gate pills refresh after every action the console itself takes", () => {
  // The banner and history are a fold over the gate-audit log, and loadTrustDb had exactly
  // three callers: mount, threat-DB update, revoke. So a user could run a scan on this very
  // page and watch the allow/warn/block counts not move - a mount-time snapshot presented
  // as live state.
  const s = src();
  for (const fn of ["runGate", "scanThreat", "forceInstall"]) {
    const body = new RegExp(`const ${fn} = useCallback\\([\\s\\S]*?\\n  \\);`).exec(s)?.[0] ?? "";
    assert.ok(body, `${fn} not found`);
    assert.match(body, /void loadTrustDb\(\)/, `${fn} does not refresh the gate pills`);
    assert.match(body, /loadTrustDb,?\n?\s*\]/, `${fn} omits loadTrustDb from its deps`);
  }
});

test("Inspect REVEALS a quarantined artifact; it never opens it", () => {
  // section 4 lists Inspect beside Delete, and there was no way to look at a vault item at
  // all. The verb matters: `openPath` is the OS's "open", which would hand an artifact the
  // gate refused to whatever application claims its extension. Reveal shows it inert.
  const s = src();
  assert.match(s, /onInspect=\{\(id\) => \{/, "the vault has no Inspect action");
  // The VAULT ARTIFACT, not `item.path`: nemesis removes the original after copying it, so the
  // original path is guaranteed not to exist and revealing it showed the operator nothing.
  assert.match(s, /const artifact = `\$\{quarantineDir\}\/\$\{item\.id\}\.gz`/);
  assert.match(s, /window\.prometheus\?\.revealPath\?\.\(artifact\)/);
  assert.doesNotMatch(
    s,
    /revealPath\?\.\(item\.path\)/,
    "the original path is the ORIGIN, not a location on disk",
  );
  // …and the answer is surfaced rather than assumed: the old call was `void`ed and followed by
  // an unconditional "revealed <path>".
  assert.match(s, /could not reveal/);
  assert.match(s, /was erased, not quarantined/, "an erased record has no copy to inspect");
  assert.doesNotMatch(
    s,
    /onInspect[\s\S]{0,300}openPath/,
    "Inspect must never route through openPath - that RUNS the artifact",
  );
});

test("the vault row carries section 4's reassurance copy", () => {
  const vault = readFileSync(
    join(HERE, "..", "..", "..", "..", "packages", "ui", "src", "security", "QuarantineVault.tsx"),
    "utf8",
  );
  assert.match(vault, /isolated, never executed/);
});
