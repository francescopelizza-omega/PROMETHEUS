// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/tmux-driver.ts — the real RelayTmux: observe / deliver / live / teardown.
 *
 * Implements the core `RelayTmux` seam over actual tmux: it reads a pane's state
 * (display-message + capture-pane → the idle-classifier), delivers a peer message as a
 * fresh input turn (the footgun-safe `send-keys -l --` then a SEPARATE literal Enter), lists
 * which agent windows are still live, and kills the session at the end. The single tmux
 * runner captures STDOUT (tmux.ts's runner returns only status/stderr) via createRequire'd
 * child_process (engine-bridge's C5 boundary). The classify/argv logic is unit-tested with
 * an injected run seam; nothing spawns in tests.
 */
import { createRequire } from "node:module";

import type { orchestration } from "@prometheus/core";

import { captureDigest, classifyPane } from "./idle-classifier.js";

const nodeRequire = createRequire(import.meta.url);

type RelayTmux = orchestration.RelayTmux;
type AgentObservation = orchestration.AgentObservation;

/** A captured tmux invocation. */
export interface TmuxResult {
  status: number;
  stdout: string;
  stderr: string;
}
export type TmuxRun = (argv: string[]) => TmuxResult;

/** The real runner: `tmux <argv>`, capturing stdout (no shell). */
export function makeTmuxRun(): TmuxRun {
  const cp = nodeRequire("node:child_process") as {
    spawnSync: (
      bin: string,
      argv: string[],
      opts: Record<string, unknown>,
    ) => { status: number | null; stdout?: string; stderr?: string };
  };
  return (argv: string[]) => {
    const r = cp.spawnSync("tmux", argv, { encoding: "utf8", timeout: 10_000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** Strip raw control bytes (keep printable) so a payload can't re-arm tmux's prefix/cursor. */
function sanitizeLine(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\n/g, " ");
}

export interface TmuxRelayDeps {
  session: string;
  /** the agents (window names) in this swarm. */
  agents: string[];
  /** agent → its CLI service (for the vendor idle profile). */
  serviceOf: (agent: string) => string;
  /** the tmux runner (default: real). */
  run?: TmuxRun;
  /** how many tail lines to capture for idle detection. */
  captureLines?: number;
  /**
   * CLI-075: the argv (AFTER `respawn-pane -k -t <target>`) that re-launches a crashed agent's
   * pane in place — the same env (`-e KEY=VAL …`) + interactive command used at spawn. `null` ⇒
   * the agent can't be re-launched (no respawn). Needs `remain-on-exit on` set at spawn so a dead
   * pane stays listed with `#{pane_dead}`.
   */
  relaunch?: (agent: string) => string[] | null;
}

/** Build the real RelayTmux the scheduler drives. */
export function makeTmuxRelay(deps: TmuxRelayDeps): RelayTmux {
  const run = deps.run ?? makeTmuxRun();
  // digest the whole visible pane (so ANY change resets the quiescence streak).
  const lines = deps.captureLines ?? 200;
  const target = (agent: string): string => `${deps.session}:${agent}`;

  const windowExists = (agent: string): boolean =>
    run(["display-message", "-p", "-t", target(agent), "#{pane_id}"]).status === 0;

  return {
    liveAgents(): string[] {
      return deps.agents.filter(windowExists);
    },

    observe(agent: string): AgentObservation {
      const t = target(agent);
      // #{pane_dead}=1 ⇒ the process exited; do NOT use pane_current_command for dead (tmux
      // wraps the agent in a shell, so "sh" foreground is normal, not an exit).
      const probe = run(["display-message", "-p", "-t", t, "#{pane_dead}|#{pane_in_mode}"]);
      if (probe.status !== 0) return { state: "dead", digest: "" }; // window gone
      const [paneDead = "0", inMode = "0"] = probe.stdout.trim().split("|");
      // capture the FULL visible pane — the prompt marker may be at the top (short output)
      // or the bottom (a scrolling CLI); lastNonEmptyLine finds it either way.
      const capture = run(["capture-pane", "-p", "-t", t]).stdout;
      const state = classifyPane(deps.serviceOf(agent), {
        inMode,
        capture,
        dead: paneDead === "1",
      });
      return { state, digest: captureDigest(capture, lines) };
    },

    deliver(agent: string, line: string): void {
      const t = target(agent);
      const text = sanitizeLine(line);
      // 1) the body as ONE literal chunk (-l = verbatim, -- = end options).
      run(["send-keys", "-t", t, "-l", "--", text]);
      // 2) submit as a SEPARATE genuine Return (folding Enter into -l would TYPE "Enter").
      run(["send-keys", "-t", t, "Enter"]);
    },

    respawn(agent: string): boolean {
      const t = target(agent);
      // a clean exit (pane_dead_status 0) is legitimate completion — do NOT respawn it. Only a
      // crash (non-zero exit) is a respawn candidate. pane_dead_status is populated only while the
      // dead pane is retained (`remain-on-exit on`), which demos-tmux sets at spawn.
      const probe = run(["display-message", "-p", "-t", t, "#{pane_dead}|#{pane_dead_status}"]);
      const [dead = "0", status = ""] = probe.stdout.trim().split("|");
      if (dead === "1" && status === "0") return false; // exited cleanly — treat as done, not a crash
      const extra = deps.relaunch?.(agent);
      if (!extra || extra.length === 0) return false; // nothing to re-launch
      // respawn-pane -k kills any lingering process, then runs the command fresh in the same pane.
      return run(["respawn-pane", "-k", "-t", t, ...extra]).status === 0;
    },

    teardown(_reason: string): void {
      run(["kill-session", "-t", deps.session]);
    },
  };
}

/** Type a line into a window WITHOUT submitting-as-genuine-Enter cleanup — used to inject the
 *  one-time preamble at session start (same literal+Enter discipline). */
export function injectLine(run: TmuxRun, session: string, agent: string, line: string): void {
  const t = `${session}:${agent}`;
  run(["send-keys", "-t", t, "-l", "--", sanitizeLine(line)]);
  run(["send-keys", "-t", t, "Enter"]);
}
