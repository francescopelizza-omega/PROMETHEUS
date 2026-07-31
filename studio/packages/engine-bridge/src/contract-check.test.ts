/**
 * contract-check.test.ts — the §6.4 golden-envelope contract test.
 *
 * Shells the REAL `python3 prometheus.py --json <cmd>` through the bridge
 * (runPrometheus) and asserts the engine still honors the contract: stdout is one
 * parseable JSON object, `command` is always set (emit_json), `ok` is a boolean, and
 * EVERY key in the committed golden snapshot still exists (a rename/removal — the
 * dangerous drift like risk_score→score — fails loudly). Guarded: when the engine
 * is absent (a runner without python/the repo), the cases skip instead of failing.
 *
 * Regenerate goldens with `node scripts/capture-contract.mjs` and commit the diff.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveEngine } from "./config.js";
import { runPrometheus } from "./run.js";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "..", "contract", "golden");
const { prometheusPy } = resolveEngine();
const enginePresent = existsSync(prometheusPy);
const skip = enginePresent ? false : "engine (prometheus.py) not present on this runner";

const COMMANDS = [
  { name: "list", argv: ["list"] },
  { name: "scan", argv: ["scan"] },
  { name: "matrix", argv: ["matrix"] },
  { name: "superscan", argv: ["superscan"] },
  { name: "vault-status", argv: ["vault", "status"] },
];

for (const cmd of COMMANDS) {
  test(
    `contract: ${cmd.name} still honors the one-JSON-object envelope + golden keys`,
    { skip },
    async () => {
      const golden = JSON.parse(readFileSync(join(goldenDir, `${cmd.name}.json`), "utf8")) as {
        keys: string[];
      };
      const env = (await runPrometheus(cmd.argv, { timeoutMs: 180_000 })) as Record<
        string,
        unknown
      >;
      // emit_json contract: command always set; ok is a boolean.
      assert.equal(typeof env.command, "string", `${cmd.name}: missing string "command"`);
      assert.equal(typeof env.ok, "boolean", `${cmd.name}: missing boolean "ok"`);
      // every golden key must still be present (catches a rename/removal).
      const liveKeys = new Set(Object.keys(env));
      for (const key of golden.keys) {
        assert.ok(liveKeys.has(key), `${cmd.name}: golden key "${key}" disappeared (drift!)`);
      }
    },
  );
}
