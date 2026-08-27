/**
 * secure-cmd.test.ts — the `prometheus secure …` surface (file 03): the trust ledger /
 * threat-DB reads, the preview→execute remediation, and the never-force gate. The
 * engine-bridge security functions are injected as fakes — no nemesis spawn.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { FusedUrlVerdict, NemesisVerdict, SecurityVerdict } from "@prometheus/engine-bridge";
import { fuseUrlSignals } from "@prometheus/engine-bridge";

import { makeContext } from "../context.js";
import { parseArgs } from "../parse.js";
import {
  type SecureDeps,
  buildAuditFilter,
  defangDisplay,
  exitCodeSimple,
  makeStageStreamer,
  normalizeScan,
  projectFusedVerdict,
  renderAuditLog,
  renderUrlExplain,
  runSecureCommand,
  scanFooter,
} from "./secure-cmd.js";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function fakeDeps(over: Partial<SecureDeps> = {}): { deps: SecureDeps; calls: string[] } {
  const calls: string[] = [];
  const rec =
    <R>(name: string, value: R) =>
    () => {
      calls.push(name);
      return value;
    };
  const recAsync =
    <R>(name: string, value: R) =>
    async () => {
      calls.push(name);
      return value;
    };
  const deps: SecureDeps = {
    threatDbStatus: recAsync("threatDbStatus", { ok: true }) as SecureDeps["threatDbStatus"],
    updateFeeds: recAsync("updateFeeds", {
      ok: true,
      summary: "done",
    }) as SecureDeps["updateFeeds"],
    listTrusted: rec("listTrusted", [{ name: "acme" }]) as unknown as SecureDeps["listTrusted"],
    auditLog: rec("auditLog", []) as unknown as SecureDeps["auditLog"],
    verify: recAsync("verify", { valid: true, message: "ok", exitCode: 0 }) as SecureDeps["verify"],
    revoke: recAsync("revoke", { ok: true, name: "acme" }) as SecureDeps["revoke"],
    disinfect: recAsync("disinfect", {
      ok: true,
      verdict: { verdict: "allow" },
      resolved: [],
      unresolved: [],
      output: "/out",
      errors: [],
    }) as unknown as SecureDeps["disinfect"],
    quarantineList: recAsync("quarantineList", {
      ok: true,
      listing: "",
      quarantineDir: "/q",
    }) as unknown as SecureDeps["quarantineList"],
    restore: recAsync("restore", {
      ok: true,
      id: "i",
      message: "m",
    }) as unknown as SecureDeps["restore"],
    cacheStatus: recAsync("cacheStatus", {
      ok: true,
      status: "verdict cache: 12 entries",
      entries: 12,
    }) as unknown as SecureDeps["cacheStatus"],
    clearCache: recAsync("clearCache", {
      ok: true,
      message: "cleared",
    }) as unknown as SecureDeps["clearCache"],
    authKey: recAsync("authKey", { ok: true }) as unknown as SecureDeps["authKey"],
    ignoreList: recAsync("ignoreList", {
      ok: true,
      listing: "rule-1 path/a",
    }) as unknown as SecureDeps["ignoreList"],
    acceptFinding: rec("acceptFinding", {
      ok: false,
      ruleId: "r",
      path: "p",
      supported: false,
      reason: "no scriptable add",
    }) as unknown as SecureDeps["acceptFinding"],
    ...over,
  };
  return { deps, calls };
}

const ctxFor = (argv: string[]) => makeContext(parseArgs(argv));

/**
 * Regression: a mistyped secure action used to be silently reinterpreted as a live nemesis SCAN
 * TARGET (falling into positionals, sub() defaulting to "scan") instead of the "unknown secure
 * verb" message already written below — a typo like "trussed" triggered a REAL gate() call
 * against the literal string "trussed". Fixed via parse.ts's `unmatchedSub`.
 */
test("a mistyped secure action reports 'unknown secure verb', never runs a scan against the typo", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(ctxFor(["secure", "trussed"]), deps);
  assert.equal(out.exitCode, 1);
  assert.match(out.text ?? "", /unknown secure verb/);
  assert.match(out.text ?? "", /trussed/);
  assert.deepEqual(calls, []);
});

test("secure trust list: READ renders the ledger (exit 0)", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(ctxFor(["secure", "trust", "list"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, ["listTrusted"]);
  assert.match(out.text ?? "", /acme/);
});

test("secure db cache: READ renders the verdict-cache status (cacheStatus)", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(ctxFor(["secure", "db", "cache"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, ["cacheStatus"]);
  assert.match(out.text ?? "", /12/);
});

test("secure db cache clear: PREVIEW by default (clearCache NOT called)", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(ctxFor(["secure", "db", "cache", "clear"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status: string }).status, "preview");
  assert.deepEqual(calls, []);
});

test("secure db cache clear --yes: EXECUTES clearCache", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(ctxFor(["secure", "db", "cache", "clear", "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, ["clearCache"]);
});

test("secure ignore list: READ renders the accepted findings (ignoreList)", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(ctxFor(["secure", "ignore", "list"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, ["ignoreList"]);
  assert.match(out.text ?? "", /rule-1/);
});

test("secure accept: honestly reports the non-scriptable limit (exit 2)", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(
    ctxFor(["secure", "accept", "target", "--rule", "r1", "--path", "p"]),
    deps,
  );
  assert.equal(out.exitCode, 2);
  assert.deepEqual(calls, ["acceptFinding"]);
});

test("secure db update: PREVIEW by default (updateFeeds NOT called)", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(ctxFor(["secure", "db", "update"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal((out.json as { status: string }).status, "preview");
  assert.deepEqual(calls, []);
});

test("secure db update --yes: EXECUTES updateFeeds", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(ctxFor(["secure", "db", "update", "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, ["updateFeeds"]);
});

test("secure disinfect requires --out (usage error, exit 1, no call)", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(ctxFor(["secure", "disinfect", "/tmp/x"]), deps);
  assert.equal(out.exitCode, 1);
  assert.deepEqual(calls, []);
});

test("secure disinfect --out --yes: EXECUTES disinfect", async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSecureCommand(
    ctxFor(["secure", "disinfect", "/tmp/x", "--out", "/clean", "--yes"]),
    deps,
  );
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, ["disinfect"]);
});

test("never-force: --force under ci HARD-blocks a remediation (exit 2, nothing run)", async () => {
  const prev = process.env.PROM_ALLOW_FORCE;
  // biome-ignore lint/performance/noDelete: ensure the override is truly unset
  delete process.env.PROM_ALLOW_FORCE;
  try {
    const { deps, calls } = fakeDeps();
    const out = await runSecureCommand(
      ctxFor(["--profile", "ci", "--force", "secure", "db", "update"]),
      deps,
    );
    assert.equal(out.exitCode, 2);
    assert.equal((out.json as { error: string }).error, "force-blocked");
    assert.deepEqual(calls, []);
  } finally {
    if (prev !== undefined) process.env.PROM_ALLOW_FORCE = prev;
  }
});

// ── CLI-040: `secure scan` streamed progress + normalized findings + 0/1/2 exit map ──

function nemesis(over: Record<string, unknown> = {}): NemesisVerdict {
  return {
    schema: "nemesis.verdict/1",
    verdict: "block",
    target: "evil/repo",
    risk_score: 90,
    scanned_at: "2026-07-17T00:00:00Z",
    policy: "default",
    cached: false,
    unscannable: false,
    severity_counts: { CRITICAL: 1, HIGH: 2, MEDIUM: 0, LOW: 3, INFO: 5 },
    class_counts: { malware: 1 },
    top_findings: [
      {
        rule_id: "PROM-MAL-001",
        severity: "CRITICAL",
        klass: "malware",
        path: "setup.py",
        detail: "pipes remote script into sh",
        remediable: false,
      },
    ],
    blocking_reasons: ["malware match"],
    recommendation: "Do not install.",
    ...over,
  } as unknown as NemesisVerdict;
}

test("exitCodeSimple: the 0/1/2 scripting map (error stays fail-closed at 2) (CLI-040)", () => {
  assert.equal(exitCodeSimple("allow"), 0);
  assert.equal(exitCodeSimple("warn"), 1);
  assert.equal(exitCodeSimple("block"), 2);
  assert.equal(exitCodeSimple("error"), 2);
});

test("normalizeScan: RED NemesisVerdict → findings + full counts + exit 2 (CLI-040)", () => {
  const n = normalizeScan(nemesis());
  assert.equal(n.verdict, "block");
  assert.equal(n.exitCode, 2);
  assert.equal(n.findings.length, 1);
  assert.equal(n.findings[0]?.rule, "PROM-MAL-001");
  assert.equal(n.findings[0]?.path, "setup.py");
  assert.equal(n.findings[0]?.verdict, "malware"); // the uniform class axis
  assert.equal(n.findings[0]?.excerpt, "pipes remote script into sh");
  // counts come from the FULL severity_counts, not the truncated top_findings.
  assert.deepEqual(n.counts, { critical: 1, high: 2, medium: 0, low: 3 });
  assert.ok(n.raw); // the untouched original is preserved
});

test("normalizeScan: warn → exit 1; light SecurityVerdict clean → exit 0 + zero counts (CLI-040)", () => {
  assert.equal(normalizeScan(nemesis({ verdict: "warn" })).exitCode, 1);
  const clean: SecurityVerdict = {
    verdict: "allow",
    risk_score: 0,
    signed: false,
    findings: [],
    scannedAt: "2026-07-17T00:00:00Z",
    target: "./ok",
  };
  const n = normalizeScan(clean);
  assert.equal(n.exitCode, 0);
  assert.equal(n.ok, true);
  assert.deepEqual(n.counts, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.match(scanFooter(n.counts), /clean — no findings/);
  // a light path with findings counts by severity.
  const withFindings: SecurityVerdict = {
    ...clean,
    verdict: "block",
    findings: [
      { klass: "malware", severity: "critical", rule: "R1", where: "a" },
      { klass: "vuln", severity: "high", rule: "R2", where: "b" },
    ],
  };
  const nf = normalizeScan(withFindings);
  assert.deepEqual(nf.counts, { critical: 1, high: 1, medium: 0, low: 0 });
  assert.match(scanFooter(nf.counts), /2 findings — 1 critical · 1 high/);
});

test("makeStageStreamer: emits one labeled line per stage TRANSITION, in order (CLI-040)", () => {
  const out: string[] = [];
  const onLine = makeStageStreamer((s) => out.push(s));
  // many lines per phase; only transitions print.
  onLine("fetching evil/repo …");
  onLine("fetching more objects");
  onLine("applying static rules");
  onLine("matching secret patterns");
  onLine("checking threat feeds");
  onLine("computing risk score → verdict");
  onLine(""); // blank ignored
  assert.equal(out.length, 4, "one line per stage transition (resolve→static→threatdb→verdict)");
  assert.match(out[0] ?? "", /^\[1\/4\] resolve target — fetching evil\/repo/);
  assert.match(out[1] ?? "", /^\[2\/4\] static rules/);
  assert.match(out[2] ?? "", /^\[3\/4\] threat feeds/);
  assert.match(out[3] ?? "", /^\[4\/4\] verdict/);
});

/* ── CLI-079: extended trust-log filters + `gate history` alias ─────────────────── */

const ctxFor2 = (argv: string[]) => makeContext(parseArgs(argv));

test("CLI-079 buildAuditFilter parses the 4 new flags (+ AND with the 3 booleans)", () => {
  const f = buildAuditFilter(
    ctxFor2([
      "secure",
      "trust",
      "log",
      "--blocks",
      "--target",
      "evil",
      "--since",
      "2026-07-01",
      "--until",
      "2026-07-05",
      "--rule",
      "curl",
    ]),
  );
  assert.equal(f.blocks, true);
  assert.equal(f.target, "evil");
  assert.equal(f.since, "2026-07-01");
  assert.equal(f.until, "2026-07-05");
  assert.equal(f.rule, "curl");
});

test("CLI-079 `secure trust log --json` echoes the applied filter + resolved bounds", async () => {
  const { deps } = fakeDeps();
  const out = await runSecureCommand(
    ctxFor2(["secure", "trust", "log", "--since", "2026-07-03", "--json"]),
    deps,
  );
  const j = out.json as {
    ok: boolean;
    filter: { since?: string };
    bounds: { sinceMs: number | null };
    entries: unknown[];
  };
  assert.equal(j.ok, true);
  assert.equal(j.filter.since, "2026-07-03");
  assert.equal(j.bounds.sinceMs, Date.parse("2026-07-03T00:00:00Z"));
  assert.ok(Array.isArray(j.entries));
});

test("CLI-079 the filter the CLI builds is the one handed to auditLog", async () => {
  let seen: unknown;
  const { deps } = fakeDeps({
    auditLog: ((f: unknown) => {
      seen = f;
      return [];
    }) as unknown as SecureDeps["auditLog"],
  });
  await runSecureCommand(ctxFor2(["secure", "trust", "log", "--target", "pypi"]), deps);
  assert.equal((seen as { target?: string }).target, "pypi");
});

test("CLI-079 `gate history` reuses `secure trust log`'s exact renderer (one code path, no drift)", () => {
  // gate.ts imports `buildAuditFilter` + `renderAuditLog` from secure-cmd (proven by this shared
  // import compiling); the renderer is deterministic, so identical (json, filter, rows) → identical
  // output. `prometheus gate history` itself is verified to return the audit envelope end-to-end.
  const ctx = ctxFor2(["secure", "trust", "log", "--blocks", "--since", "2026-07-03", "--json"]);
  const filter = buildAuditFilter(ctx);
  const rows: never[] = [];
  assert.deepEqual(renderAuditLog(ctx.json, filter, rows), renderAuditLog(ctx.json, filter, rows));
  const env = renderAuditLog(ctx.json, filter, rows).json as {
    ok: boolean;
    filter: { since?: string };
    bounds: { sinceMs: number | null };
  };
  assert.equal(env.ok, true);
  assert.equal(env.filter.since, "2026-07-03");
  assert.equal(env.bounds.sinceMs, Date.parse("2026-07-03T00:00:00Z"));
});

/* ── CLI-080: `secure --explain` URL-injection L0-L6 layer trace ─────────────────── */

const FUSED: FusedUrlVerdict = {
  tier: "block",
  degraded: false,
  reasons: ["classifier malicious @ https://evil.example/x"],
  findings: [
    {
      rule_id: "URL-IPI",
      severity: "HIGH",
      klass: "malware",
      category: "ioc",
      path: "u",
      detail: "classifier 'prompt-guard-2' scored content malicious (0.9)",
      evidence: "beacon https://c2.evil.example/cb",
    },
    {
      rule_id: "URL-IPI",
      severity: "MEDIUM",
      klass: "malware",
      category: "ioc",
      path: "u",
      detail: "fetched content carries 2 injection signal(s)",
    },
    {
      rule_id: "URL-CLOAK",
      severity: "HIGH",
      klass: "malware",
      category: "ioc",
      path: "u",
      detail: "cloaking probe diverged (similarity 0.2)",
    },
    {
      rule_id: "URL-OPAQUE",
      severity: "MEDIUM",
      klass: "malware",
      category: "obfuscation",
      path: "u",
      detail: "3 opaque encoded-URL blob(s) could not be vetted",
    },
  ],
};

test("CLI-080 renderUrlExplain: per-layer L0/L3/L4/L6 trace, HIGH-first, evidence DEFANGED", () => {
  const out = stripAnsi(renderUrlExplain(FUSED));
  assert.match(out, /URL-injection layer trace/);
  assert.match(out, /L0 {2}opaque/);
  assert.match(out, /L3 {2}cloaking probe/);
  assert.match(out, /L4 {2}content classifier/);
  assert.match(out, /L6 {2}fetched-content/);
  assert.match(out, /URL-OPAQUE/); // L0 finding
  assert.match(out, /URL-CLOAK/); // L3 finding
  assert.match(out, /URL-IPI/); // L4 + L6
  // no LIVE url survives the render (defanged); the neutralized form is present.
  assert.ok(!/https?:\/\//.test(out), "the rendered trace must contain no live http(s) URL");
  assert.match(out, /hxxp/);
});

test("CLI-080 degraded fusion → a distinct own-line caveat (not a hidden footnote)", () => {
  const out = stripAnsi(renderUrlExplain({ ...FUSED, degraded: true }));
  const caveat = out.split("\n").find((l) => /DEGRADED/.test(l));
  assert.ok(caveat, "a DEGRADED caveat line must exist");
  assert.match(caveat ?? "", /unavailable|heuristic-only/);
  assert.match(caveat ?? "", /NOT a full-confidence/);
});

test("CLI-080 projectFusedVerdict passes a stored verdict_full through UNTOUCHED (one renderer)", () => {
  // deliverable 2/3: a stored FusedUrlVerdict is returned identically (json-untouched) while the
  // human renderer defangs — proven by the same object rendering with no live URL.
  assert.deepEqual(projectFusedVerdict(FUSED), FUSED);
  assert.equal(projectFusedVerdict(FUSED), FUSED); // same reference — truly untouched
  assert.ok(!/https?:\/\//.test(stripAnsi(renderUrlExplain(FUSED))));
});

test("CLI-080 projectFusedVerdict extracts URL-* findings from a live scan verdict", () => {
  const v = projectFusedVerdict({
    verdict: "block",
    target: "evil/repo",
    top_findings: [
      { rule_id: "PROM-MAL-001", severity: "CRITICAL", detail: "not a url finding" },
      { rule_id: "URL-IPI", severity: "HIGH", path: "u", detail: "classifier scored malicious" },
      { rule_id: "URL-OPAQUE", severity: "MEDIUM", path: "u", detail: "1 opaque blob" },
    ],
  });
  assert.equal(v.findings.length, 2); // only the URL-* rules
  assert.equal(v.tier, "block"); // a HIGH URL finding → block
  assert.ok(v.findings.some((f) => f.rule_id === "URL-IPI"));
});

test("CLI-080 fuseUrlSignals(opaque) integrates with the renderer (real fusion math)", () => {
  const real = fuseUrlSignals({ url: "https://x.example/p", opaque: 4 });
  const out = stripAnsi(renderUrlExplain(real));
  assert.match(out, /L0 {2}opaque/);
  assert.match(out, /URL-OPAQUE/);
  assert.equal(real.tier, "warn"); // one additive opaque signal → warn
});

test("CLI-080 defangDisplay neutralizes a live URL but leaves plain text", () => {
  assert.equal(defangDisplay("run https://a.b/c now"), "run hxxps://a[.]b/c now");
  assert.equal(defangDisplay("no url here"), "no url here");
});

test("CLI-085 --quiet never suppresses a command's actual RESULT (only chatter)", async () => {
  const { deps, calls } = fakeDeps();
  // `secure db cache` under --quiet still returns its result envelope + runs the dep.
  const out = await runSecureCommand(ctxFor2(["--quiet", "secure", "db", "cache"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(calls, ["cacheStatus"]);
  assert.match(out.text ?? "", /12/); // the result (cache entry count) is present, not muted
});
