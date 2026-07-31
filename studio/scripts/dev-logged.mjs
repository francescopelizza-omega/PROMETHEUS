#!/usr/bin/env node
/**
 * dev-logged.mjs — run the desktop app in dev (`electron-vite dev`) and TEE every
 * line of stdout + stderr to a log file, verbatim, while still printing to the
 * terminal. So the FULL boot/runtime output (vite, electron main, renderer console
 * forwarded by electron-vite, stack traces) is captured to a fixed path an
 * assistant can read back without losing detail.
 *
 *   pnpm dev:logged
 *
 * Logs:
 *   studio/.dev-logs/dev-latest.log     (always the most recent run — read THIS)
 *   studio/.dev-logs/dev-<timestamp>.log (kept history)
 *
 * Ctrl-C stops the app cleanly; the log keeps the exit code.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const logDir = join(studioRoot, ".dev-logs");
mkdirSync(logDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const histPath = join(logDir, `dev-${stamp}.log`);
const latestPath = join(logDir, "dev-latest.log");
const hist = createWriteStream(histPath, { flags: "w" });
const latest = createWriteStream(latestPath, { flags: "w" });

const banner = `[dev-logged] ${new Date().toISOString()}
[dev-logged] full logs → ${latestPath}
[dev-logged] launching: pnpm --filter @prometheus/desktop dev
[dev-logged] (first boot compiles the renderer — give it 10-20s; Ctrl-C to stop)

`;
process.stdout.write(banner);
hist.write(banner);
latest.write(banner);

// Run the SAME command `pnpm dev` runs for the desktop, but unbuffered + teed.
const child = spawn("pnpm", ["--filter", "@prometheus/desktop", "dev"], {
  cwd: studioRoot,
  env: { ...process.env, FORCE_COLOR: "1" },
});

function tee(src, sink) {
  src.on("data", (buf) => {
    sink.write(buf);
    hist.write(buf);
    latest.write(buf);
  });
}
tee(child.stdout, process.stdout);
tee(child.stderr, process.stderr);

child.on("error", (err) => {
  const line = `\n[dev-logged] FAILED to launch: ${err.message}\n[dev-logged] is the workspace installed?  cd studio && pnpm install\n`;
  process.stderr.write(line);
  hist.write(line);
  latest.write(line);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  const line = `\n[dev-logged] app exited (code=${code} signal=${signal})\n`;
  process.stdout.write(line);
  hist.write(line);
  latest.write(line);
  process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill("SIGINT"));
}
