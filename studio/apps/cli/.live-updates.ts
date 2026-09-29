import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updates as u } from "@prometheus/core";
import { checkUpdates } from "./src/updates/check.js";

let serverVersions: Record<string, string> = {};
try {
  const r = await fetch("http://127.0.0.1:11434/api/version", { signal: AbortSignal.timeout(1500) });
  if (r.ok) { const j = await r.json() as { version?: string }; if (j.version) serverVersions.ollama = j.version; }
} catch {}

const t0 = Date.now();
const { report } = await checkUpdates({
  home: mkdtempSync(join(tmpdir(), "prom-live-")),
  promVersion: "0.1.0",
  scriptPath: process.argv[1],
  force: true,
  serverVersions,
});
console.log(u.formatUpdateReport(report));
console.log(`\n--- ${Date.now() - t0} ms ---`);
console.log("startup line:", JSON.stringify(u.summarizeForStartup(report)));
