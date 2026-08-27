/**
 * register.mjs — the loader hook for session.test.ts's plain node:test run: registers the CLI's
 * own dev-resolver (so "@prometheus/core/agent-loop" etc. resolve to SOURCE, not a possibly
 * stale dist/) plus one extra resolve rule mapping the bare "vscode" specifier to a tiny empty
 * stub, since it has no real installed package outside the actual VS Code extension host.
 *
 * Two SEPARATE `register()` calls, not one merged hook — Node chains registered hooks, so this
 * adds one narrow rule on top of the CLI's existing, already-tested resolver rather than forking
 * or duplicating it.
 */
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

register(`file://${resolve(HERE, "..", "..", "..", "cli", "dev-resolver.mjs")}`);

const STUB_URL = pathToFileURL(resolve(HERE, "vscode-stub.mjs")).href;
register(
  `data:text/javascript,${encodeURIComponent(
    `export async function resolve(specifier, context, next) {
      if (specifier === "vscode") return { url: ${JSON.stringify(STUB_URL)}, shortCircuit: true };
      return next(specifier, context);
    }`,
  )}`,
);
