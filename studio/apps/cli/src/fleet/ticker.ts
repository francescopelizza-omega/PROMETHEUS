/**
 * fleet/ticker.ts — the clock behind the fleet bar.
 *
 * Owns three things and nothing else: this instance's heartbeat, a periodic read of everyone
 * else's, and — only when there IS someone else — a resource probe.
 *
 * ## A lone session must cost nothing
 *
 * The meter probe spawns `ps` (and `vm_stat` on macOS). If it ran unconditionally, every
 * Prometheus on the machine would spawn two processes every three seconds forever to render a
 * bar that says `prom 1`. So the probe is gated on the fleet actually having peers, and the bar
 * itself returns null at a total of one. A user who never opens a second window never pays for
 * this feature at all.
 *
 * ## Repaint only on a real change
 *
 * `onChange` fires when the MODEL changes in a way the bar would show — not on every tick. CPU
 * jitter of a tenth of a percent must not repaint the frame twice a second; the comparison is
 * over the rounded, rendered values, so the callback fires exactly when the pixels would differ.
 */
import { type EvictionEvent, readEvictionEvents } from "@prometheus/engine-bridge";
import type { FleetBarModel } from "../tui/fleet-bar.js";

import {
  type FleetPeer,
  type PeerState,
  TICK_MS,
  clearHeartbeat,
  fleetCounts,
  fleetPids,
  readFleet,
  writeHeartbeat,
} from "./heartbeat.js";
import { type FleetMeters, METER_TICK_MS, readFleetMeters } from "./meters.js";

export interface FleetTickerOptions {
  /** the PROMETHEUS_HOME root; defaults to the resolved one. */
  home?: string;
  /** this session's id (ties a row back to `/recall`). */
  id: string;
  /** read fresh every tick — the cwd moves under `/cd`. */
  cwd: () => string;
  /** read fresh every tick — the model changes under `/model`. */
  model: () => string;
  /** called when the rendered bar would differ from the last one. */
  onChange?: () => void;
  /**
   * ACTIVE EVICTION: called once per NEW entry in the shared eviction log (engine-bridge's
   * eviction-log.ts) — a Prometheus-managed local model server was force-stopped somewhere
   * (this session's own watchdog, another CLI shell's, or the desktop app's) to prevent a
   * machine-wide freeze. Checked every tick unconditionally: unlike the meter probe, this is a
   * single local file read, never a spawn, so a lone session pays for it too — the whole point
   * is that a session doing nothing else still learns its model just got stopped.
   */
  onEviction?: (event: EvictionEvent) => void;
  /** injected in tests. */
  now?: () => number;
  pid?: number;
  /** injected in tests — defaults to the real, shared `readEvictionEvents`. */
  readEvictionEventsFn?: (home?: string) => EvictionEvent[];
}

export interface FleetTicker {
  /** the current bar model, or null before the first read. */
  model(): FleetBarModel | null;
  /** the peers behind that model (what `/fleet` tables). */
  peers(): FleetPeer[];
  /** the meters behind it, or null when nothing has been probed yet. */
  meters(): FleetMeters | null;
  /** what this instance reports about itself. */
  setState(state: PeerState): void;
  /** force one refresh now (`/fleet` calls this so the table is never a tick stale). */
  refresh(): Promise<void>;
  stop(): void;
}

/** The rendered identity of a model — what `onChange` compares. */
function fingerprint(m: FleetBarModel | null): string {
  if (!m) return "";
  const meter = (x: { pct: number | null; oursPct?: number } | undefined): string =>
    x
      ? `${x.pct === null ? "-" : Math.round(x.pct)}/${x.oursPct === undefined ? "-" : Math.round(x.oursPct)}`
      : "";
  const p = m.peers;
  return [
    p.total,
    p.working,
    p.idle,
    p.needsYou,
    p.dead,
    meter(m.cpu),
    meter(m.ram),
    meter(m.gpu),
    (m.accelerators ?? []).join(","),
  ].join("|");
}

export function startFleetTicker(opts: FleetTickerOptions): FleetTicker {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const term = process.env.TMUX_PANE || process.env.TERM_PROGRAM || "";
  let state: PeerState = "idle";
  let peers: FleetPeer[] = [];
  let meters: FleetMeters | null = null;
  let model: FleetBarModel | null = null;
  let print = "";
  let meterAt = 0;
  let probing = false;
  let stopped = false;
  const readEvictions = opts.readEvictionEventsFn ?? readEvictionEvents;
  // Seed on the FIRST tick with whatever is already in the log, rather than replaying old news
  // as if it just happened — only events recorded AFTER this ticker started are ever announced.
  let lastSeenEvictionId: string | null = null;
  let evictionSeeded = false;

  const beat = (): void => {
    writeHeartbeat(
      {
        pid,
        id: opts.id,
        startedAt,
        updatedAt: new Date(now()).toISOString(),
        cwd: opts.cwd(),
        model: opts.model(),
        state,
        ...(term ? { term } : {}),
      },
      opts.home,
    );
  };

  const rebuild = (): void => {
    const counts = fleetCounts(peers);
    model =
      meters === null
        ? { peers: counts, cpu: { pct: null }, ram: { pct: null } }
        : {
            peers: counts,
            cpu: meters.cpu,
            ram: meters.ram,
            ...(meters.gpu ? { gpu: meters.gpu } : {}),
            accelerators: meters.accelerators,
          };
    const next = fingerprint(model);
    if (next !== print) {
      print = next;
      opts.onChange?.();
    }
  };

  /**
   * ACTIVE EVICTION: announce every eviction-log entry recorded SINCE this ticker last checked
   * (never events already there when it started — those are old news the moment we seed). Runs
   * every tick, no gating: a single local JSON read costs far less than the `ps` spawn the
   * meter probe guards against, and a lone session must still learn its own model got stopped.
   */
  const checkEvictions = (): void => {
    const events = readEvictions(opts.home);
    if (!evictionSeeded) {
      evictionSeeded = true;
      lastSeenEvictionId = events.at(-1)?.id ?? null;
      return;
    }
    const lastIdx = lastSeenEvictionId ? events.findIndex((e) => e.id === lastSeenEvictionId) : -1;
    const fresh = lastIdx >= 0 ? events.slice(lastIdx + 1) : events;
    for (const event of fresh) opts.onEviction?.(event);
    if (events.length > 0) lastSeenEvictionId = events.at(-1)?.id ?? lastSeenEvictionId;
  };

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    beat();
    checkEvictions();
    peers = readFleet({ ...(opts.home ? { home: opts.home } : {}), now: now(), self: pid });
    // Gate the spawn on there actually being someone else to compare against.
    const live = fleetPids(peers);
    if (peers.length > 1 && now() - meterAt >= METER_TICK_MS && !probing) {
      probing = true;
      meterAt = now();
      try {
        meters = await readFleetMeters(live);
      } catch {
        meters = null; // every meter degrades to "unknown", which the bar renders honestly
      } finally {
        probing = false;
      }
    } else if (peers.length <= 1) {
      meters = null;
    }
    rebuild();
  };

  // Register before the first tick so a second window opened one second later already sees us.
  beat();
  /**
   * The first cycle is DEFERRED, not run inline.
   *
   * `cycle()` ends in `onChange`, and running it during construction calls the caller's callback
   * before the caller's own `const`/`let` bindings around this call have been initialised — a
   * temporal-dead-zone ReferenceError thrown from inside a constructor, which surfaces as an
   * unhandled rejection with a stack that points here rather than at the real cause. A ticker
   * must not be able to reach into a half-built caller no matter what that caller declares.
   */
  queueMicrotask(() => void cycle());
  const timer = setInterval(() => void cycle(), TICK_MS);
  timer.unref?.();

  return {
    model: () => model,
    peers: () => peers,
    meters: () => meters,
    setState: (s) => {
      // `stopped` first: `stop()` clears the heartbeat FILE, and a late state change — a turn's
      // `finally { fleetState("idle") }` or `whileBlocked`'s restore, both of which can run after
      // Ctrl-D because the close handler does not await the in-flight chain — used to `beat()`
      // the file straight back onto disk with nothing left to remove it again. Every other window
      // then showed this session as `dead` for the five minutes until readFleet's sweep, which is
      // exactly what stop() exists to prevent. `cycle()` has always had this guard.
      if (stopped || s === state) return;
      state = s;
      // Write immediately: `needs-you` that waits up to two seconds to appear is exactly the
      // state a user is standing there waiting to see.
      beat();
      peers = peers.map((p) => (p.pid === pid ? { ...p, state: s } : p));
      rebuild();
    },
    refresh: () => cycle(),
    stop: () => {
      stopped = true;
      clearInterval(timer);
      clearHeartbeat(pid, opts.home);
    },
  };
}
