/**
 * orchestration/relay-seams.ts — the injected machine seams for the relay scheduler.
 *
 * The scheduler (relay-scheduler.ts) is PURE: every tmux/clock touch is behind these
 * interfaces, with the real implementations in apps/cli (tmux send-keys / capture-pane /
 * the unix-socket bus relay). Tests drive the scheduler with scripted fakes — no tmux, no
 * sockets, no real time.
 */

/** A pane's readiness for a new input turn (mirrors the apps/cli idle-classifier union). */
export type PaneState = "idle" | "busy" | "dead";

/** One observation of an agent's window this tick. */
export interface AgentObservation {
  state: PaneState;
  /** a digest of the captured tail — stable ⇒ the screen is quiescent (not streaming). */
  digest: string;
}

/** The tmux side the scheduler drives (real impl in apps/cli). */
export interface RelayTmux {
  /** the agent names with a live window right now. */
  liveAgents(): Promise<string[]> | string[];
  /** classify one agent's pane (idle/busy/dead) + a capture digest. */
  observe(agent: string): Promise<AgentObservation> | AgentObservation;
  /** type a line into an agent's window as a fresh input turn (send-keys -l -- + Enter). */
  deliver(agent: string, line: string): Promise<void> | void;
  /**
   * Respawn a crashed agent's window IN PLACE (CLI-075) — `true` ⇒ it came back and should
   * resume participating; `false`/absent ⇒ no respawn (the scheduler counts one failed attempt
   * toward the cap, then excludes it). Backend-agnostic: the tmux impl re-launches the pane; a
   * headless impl could re-issue the backend call. Optional so existing fakes stay valid.
   */
  respawn?(agent: string): Promise<boolean> | boolean;
  /** tear the session down (kill windows). */
  teardown(reason: string): Promise<void> | void;
}

/** Injected clock (deterministic in tests). */
export interface RelayClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Tunable relay limits (all have safe defaults). */
export interface RelayConfig {
  /** poll cadence. */
  tickMs: number;
  /** consecutive idle ticks required before delivering (no between-token gaps). */
  settleTicks: number;
  /** per-agent inbox cap before coalescing/dropping log lines. */
  inboxCap: number;
  /** all-idle + queued + nothing-delivered for this many ticks ⇒ deadlock. */
  deadlockTicks: number;
  /** all-idle + empty + stable for this many ticks ⇒ complete. */
  quiesceTicks: number;
  /** identical (from,to,content) re-sends past this in a window ⇒ a loop edge. */
  loopThreshold: number;
  /** per-agent respawn attempts before it is permanently excluded (CLI-075). Small + bounded so a
   *  persistently-crashing agent can't loop forever; after the cap the swarm continues without it. */
  respawnCap: number;
  /** hard safety ceiling for a whole run. */
  maxRunMs: number;
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  tickMs: 250,
  settleTicks: 2,
  inboxCap: 32,
  deadlockTicks: 24,
  quiesceTicks: 12,
  loopThreshold: 5,
  respawnCap: 1,
  maxRunMs: 30 * 60 * 1000,
};
