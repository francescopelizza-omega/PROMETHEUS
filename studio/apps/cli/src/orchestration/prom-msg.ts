/**
 * orchestration/prom-msg.ts — generate the `prom-msg` helper agents run to talk to peers.
 *
 * Each agent's tmux window gets this on PATH + the env (PROM_BUS_SOCK, PROM_AGENT). The
 * agent (or its model, via a shell tool) runs `prom-msg <to> "<text>"`; the helper writes
 * ONE NDJSON frame to the relay's UNIX socket and waits for the ACK. Identity (`from`) is
 * read from $PROM_AGENT — never an argument — so a compromised agent cannot forge a sender.
 * Two load-bearing gotchas are baked in (from the design pre-mortem): the writer KEEPS the
 * read half open and waits for the ACK line (never `end(frame)` → relay EPIPE), and exits
 * the instant the ACK arrives (a connected socket otherwise keeps node alive).
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The helper script (a self-contained node program; runs via its shebang on PATH). */
export const PROM_MSG_SCRIPT = `#!/usr/bin/env node
"use strict";
// prom-msg <to> <message...>  — send an inter-agent message to the Prometheus relay (RAM).
//   <to> = a teammate name | parent/orchestrator | all/broadcast | done
const net = require("node:net");
const sock = process.env.PROM_BUS_SOCK;
const from = process.env.PROM_AGENT || "unknown";
const to = process.argv[2];
const content = process.argv.slice(3).join(" ");
if (!sock) { console.error("prom-msg: PROM_BUS_SOCK is not set (not inside a /demos swarm)"); process.exit(1); }
if (!to) { console.error("usage: prom-msg <to> <message>"); process.exit(1); }
const frame = JSON.stringify({ from: from, to: to, content: content }) + "\\n";
let done = false;
const c = net.connect(sock, function () { c.write(frame); }); // write; KEEP the read half open for the ACK
let acc = "";
c.on("data", function (d) { acc += d.toString(); if (acc.length > 65536) acc = acc.slice(-1024); if (acc.indexOf("\\n") >= 0) { done = true; process.exit(0); } });
c.on("error", function (e) { console.error("prom-msg:", e.message); process.exit(1); });
var ackTimer = setTimeout(function () { if (!done) { console.error("prom-msg: no ack from relay"); process.exit(1); } }, 5000);
if (ackTimer.unref) ackTimer.unref();
`;

/** Write the helper into `binDir` (chmod 755) and return its path. */
export function installPromMsg(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "prom-msg");
  writeFileSync(path, PROM_MSG_SCRIPT);
  chmodSync(path, 0o755);
  return path;
}
