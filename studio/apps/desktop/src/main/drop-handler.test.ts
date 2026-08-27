/**
 * drop-handler.test.ts — an OS drag-and-drop is a grant-earning gesture; renderer JS is not.
 *
 * The `will-navigate` hook lives in `index.ts`, which cannot be imported without booting Electron
 * — so the DECISION it makes lives in `ide/drop-target.ts` and is imported here for real. A test
 * that re-implemented the predicate would be free to drift from the shipped code, which is the
 * one thing this file must not do.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { classifyNavigation, isOwnRendererUrl } from "./ide/drop-target.js";
import {
  approveOutsideWorkingSet,
  assertInsideWorkingSet,
  assertNotSensitivePath,
  clearDeclaredRoots,
  clearGrantedRoots,
  getGrantedRoots,
  grantWorkingSetRoot,
  isGrantedRoot,
  setWorkingSetRoots,
} from "./ide/path-guard.js";

test("the app's OWN renderer entry is not treated as a drop — in-app routing still works", () => {
  const entry = "/app/out/renderer/index.html";
  assert.equal(isOwnRendererUrl(pathToFileURL(entry).href, entry), true);
  // hash + query routing on the same page is still the app
  assert.equal(isOwnRendererUrl(`${pathToFileURL(entry).href}#/editor`, entry), true);
  assert.equal(isOwnRendererUrl(`${pathToFileURL(entry).href}?x=1`, entry), true);
  // anything else is not
  assert.equal(isOwnRendererUrl(pathToFileURL("/Users/me/notes.txt").href, entry), false);
  assert.equal(isOwnRendererUrl("https://example.com", entry), false);
});

test("a dropped FOLDER earns a working-set grant — the route that previously had none", () => {
  /**
   * regression: `grantWorkingSetRoot` had exactly one call site, the native Open-Folder dialog,
   * so a project opened any other way declared a root main refused and every save in it was
   * refused with "refusing to write outside the working set".
   */
  clearGrantedRoots();
  clearDeclaredRoots();
  const dropped = realpathSync(mkdtempSync(join(tmpdir(), "prom-drop-")));
  assert.equal(isGrantedRoot(dropped), false, "precondition: nothing granted yet");

  grantWorkingSetRoot(dropped); // what main does for a dropped directory
  assert.equal(setWorkingSetRoots([dropped]).accepted, 1, "the declaration is now accepted");
  assert.doesNotThrow(() => assertInsideWorkingSet(join(dropped, "src", "a.ts")));
});

test("a dropped FILE earns only a single-path approval — never a grant on its parent", () => {
  // dropping one file out of ~/Downloads must not put ~/Downloads in the agent's write scope.
  clearGrantedRoots();
  clearDeclaredRoots();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "prom-dropfile-")));
  const project = realpathSync(mkdtempSync(join(tmpdir(), "prom-proj-")));
  const file = join(parent, "notes.txt");
  writeFileSync(file, "hello", "utf8");

  grantWorkingSetRoot(project);
  setWorkingSetRoots([project]);
  approveOutsideWorkingSet(file); // what main does for a dropped file

  assert.doesNotThrow(() => assertInsideWorkingSet(file), "the dropped file itself is writable");
  assert.throws(
    () => assertInsideWorkingSet(join(parent, "sibling.txt")),
    /outside the working set/,
    "the parent directory must NOT have been granted",
  );
  assert.equal(getGrantedRoots().includes(parent), false, "the parent earned no grant");
});

test("a dropped CREDENTIAL file is still refused — the gesture does not overrule the guard", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "prom-dropsec-")));
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_rsa"), "PRIVATE KEY", "utf8");
  assert.throws(
    () => assertNotSensitivePath(join(home, ".ssh", "id_rsa")),
    /sensitive/i,
    "dragging a private key in must not approve it",
  );
});

test("classifyNavigation routes a real folder, a real file, and a missing path", () => {
  const entry = "/app/out/renderer/index.html";
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "prom-cls-")));
  const file = join(dir, "a.txt");
  writeFileSync(file, "x", "utf8");
  const stat = (p: string) => statSync(p);

  assert.deepEqual(classifyNavigation(pathToFileURL(entry).href, entry, stat), { kind: "app" });
  assert.deepEqual(classifyNavigation(pathToFileURL(dir).href, entry, stat), {
    kind: "folder",
    path: dir,
  });
  assert.deepEqual(classifyNavigation(pathToFileURL(file).href, entry, stat), {
    kind: "file",
    path: file,
  });
  // a path that cannot be stat'd must never fall through to "navigate"
  assert.deepEqual(classifyNavigation(pathToFileURL(join(dir, "gone")).href, entry, stat), {
    kind: "ignore",
  });
  assert.deepEqual(classifyNavigation("https://example.com", entry, stat), { kind: "ignore" });
});
