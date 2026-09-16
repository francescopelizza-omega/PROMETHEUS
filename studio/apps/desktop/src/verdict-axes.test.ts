/**
 * verdict-axes.test.ts — severity and decision tier are DIFFERENT axes, repo-wide.
 *
 * handoff §4, verbatim: "Severity vocabulary is `clean|low|medium|high|critical`; decision
 * tier is `allow|warn|block` — never conflate."
 *
 * `VerdictCard`'s own docblock has said so since it was written, and the component honours
 * it: the chip reads the tier, each finding reads its own severity. The rule was broken
 * OUTSIDE the component, by two callers that had free-text blocking *reasons* to render and
 * no findings to render them with. Both did the same thing:
 *
 *     findings={gate.reasons.map((r, i) => ({
 *       rule: `R-${i + 1}`,                                    // ← an invented identifier
 *       description: r,
 *       severity: gate.verdict === "warn" ? "medium" : "high", // ← the tier, restated
 *     }))}
 *
 * That is worse than it looks. The rule id sits in a mono, severity-coloured slot that
 * everywhere else in the app holds a real nemesis rule (`N-204`), so `R-1` reads as a
 * finding the scanner produced. And a severity derived from the tier is the tier a second
 * time, wearing the costume of independent corroboration — the exact thing §4's two-axis
 * rule exists to prevent.
 *
 * A unit test of `VerdictCard` cannot see any of this: the component was always correct.
 * The defect lives at the call sites, so the guard has to read them.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = dirname(dirname(dirname(HERE))); // src → desktop → apps → studio

/**
 * The roots this guard walks.
 *
 * It started as two directories of one app, and its own header said "repo-wide". An
 * adversarial pass found the identical fabrication alive one layer below it, in
 * `packages/engine-bridge/src/security/gate.ts` — shared by the CLI and the desktop — where
 * `gateCommand` mapped each blocking reason to a Finding with `rule: "nemesis"` and
 * `severity: verdict === "warn" ? "medium" : "high"`. No surface renders that table yet,
 * which is the only reason it had not been seen. A guard that stops at the app boundary
 * cannot see the shared code every app depends on.
 */
const ROOTS = [
  join(HERE, "routes"),
  join(HERE, "renderer"),
  join(STUDIO, "packages", "engine-bridge", "src"),
  join(STUDIO, "packages", "ui", "src"),
  join(STUDIO, "apps", "cli", "src"),
];

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      sources(p, out);
    } else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

const files = ROOTS.flatMap((r) => sources(r));

/**
 * A file's CODE, comments stripped.
 *
 * The forbidden expressions are ones this repo's own comments legitimately quote when they
 * explain why the fabrication was removed. A guard that a correct explanation trips is a
 * guard the next person deletes — so it reads code, never prose.
 */
function codeLines(file: string): { n: number; line: string }[] {
  const src = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return src.split("\n").map((line, i) => ({ n: i + 1, line }));
}

test("the guard is actually looking at something", () => {
  assert.ok(files.length > 200, `only ${files.length} sources scanned — the walk is wrong`);
  // the shared package the app-only version of this guard could not see
  assert.ok(
    files.some((f) => f.includes(join("engine-bridge", "src", "security", "gate.ts"))),
    "engine-bridge is not being scanned — the shared conflation would be invisible again",
  );
});

test("no renderer source DERIVES a finding severity from a decision tier", () => {
  // `severity:` on the same line as a verdict-tier comparison. Deliberately narrow: this
  // pins the specific defect, not every conceivable expression that mentions both words.
  const conflate = /severity:\s*[^,\n]*\bverdict\b[^,\n]*===\s*"(allow|warn|block|error)"/;
  const hits: string[] = [];
  for (const f of files) {
    for (const { n, line } of codeLines(f)) {
      if (conflate.test(line)) hits.push(`${f}:${n}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, [], `severity derived from a decision tier:\n${hits.join("\n")}`);
});

test("no renderer source SYNTHESISES a rule id for the findings list", () => {
  // A rule id is something the scanner said. `R-${i+1}` is something we said.
  const invented = /rule:\s*`[^`]*\$\{\s*(i|idx|index)\b/;
  const hits: string[] = [];
  for (const f of files) {
    for (const { n, line } of codeLines(f)) {
      if (invented.test(line)) hits.push(`${f}:${n}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, [], `rule ids invented from a loop index:\n${hits.join("\n")}`);
});

test("gateCommand returns reasons as REASONS, not as fabricated findings", () => {
  const gate = readFileSync(
    join(STUDIO, "packages", "engine-bridge", "src", "security", "gate.ts"),
    "utf8",
  );
  assert.match(gate, /findings: \[\],/, "gateCommand is synthesising findings again");
  assert.match(gate, /blockingReasons: reasons/, "the reasons must still reach the caller");
  assert.doesNotMatch(gate, /rule: "nemesis"/, "the invented rule id is back");
});

test("the two former offenders now pass their reasons through the `reasons` prop", () => {
  // Positive half: the guards above would also pass if the surfaces simply stopped showing
  // the gate's explanation, which would be a worse product than the conflation.
  const catalog = readFileSync(join(HERE, "routes", "catalog.tsx"), "utf8");
  assert.match(catalog, /reasons=\{pendingGate\.gate\.reasons\}/);
  const security = readFileSync(join(HERE, "routes", "security.tsx"), "utf8");
  assert.match(security, /reasons=\{[^}]*historyPicked\.blocking_reasons/);
});
