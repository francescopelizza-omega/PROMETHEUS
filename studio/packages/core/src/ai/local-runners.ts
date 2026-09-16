/**
 * ai/local-runners.ts — the local model servers Prometheus can talk to, and control.
 *
 * This list existed as a two-entry private const inside the CLI's onboarding module. The desktop
 * needed the same knowledge the moment it grew a Model Server panel, and a second copy of "which
 * runners exist and where they listen" is the kind of duplicate that only shows up as a bug much
 * later — one surface learns about a new runner and the other does not.
 *
 * What is new here beyond the URL is the CONTROL knowledge: how to start a runner, and how to
 * recognise its process when Prometheus did not start it. That second half matters more than it
 * sounds. A user who launched `ollama serve` in a terminal an hour ago has a server this app does
 * not own, and "full control" has to include that one — a Stop button that works only on servers
 * we happened to spawn is a Stop button that fails exactly when you need it.
 *
 * PURE DATA. No fetch, no spawn, no node — the callers own all of that (engine-bridge is the only
 * module allowed to spawn anything, per C5/SPINE).
 */

/** A local, OpenAI-compatible model server. */
export interface LocalRunnerSpec {
  id: string;
  /** what a human calls it. */
  name: string;
  /** the OpenAI-compatible root the client streams from (`…/v1`). */
  baseUrl: string;
  host: string;
  port: number;
  /**
   * argv that starts the server, or undefined when Prometheus cannot start this one.
   *
   * `undefined` is a real answer and the UI must say it plainly rather than showing a Start
   * button that does nothing.
   */
  start?: readonly string[];
  /**
   * argv that gracefully stops the server via the runner's OWN tooling, when it has one —
   * ALWAYS preferred over signalling whatever process this app found listening on `port`.
   *
   * This matters most when the server runs INSIDE the vendor's main application process rather
   * than as its own lightweight daemon. Verified against a real LM Studio install (2026-09):
   * `lms server stop` frees the port while the app process itself stays running; a raw
   * SIGTERM/SIGKILL on that same process quits the WHOLE app, not just its server component —
   * exactly the over-broad, disruptive action a "stop the server" control must never take.
   * `undefined` ⇒ fall back to the port-based signal escalation Ollama uses, correct for a real
   * standalone daemon (`ollama serve` has no separate `stop` subcommand — SIGTERM/SIGKILL on the
   * daemon itself IS the intended shutdown).
   */
  stop?: readonly string[];
  /**
   * A substring that identifies the runner's own process in a `ps` listing — used ONLY by the
   * signal-based stop path above (never consulted when `stop` is set) and, historically, as a
   * live-or-dead check. Do not assume this equals a vendor's marketing name forever: LM Studio's
   * OWN app process was found running as "Bionic" on a real, current install, not "LM Studio" —
   * names drift under a caller's feet. `id`/`name` below are the stable identifiers; this field
   * is a best-effort `ps` heuristic only, and any code path that has a `stop` command available
   * should use THAT instead of trying to keep this string in sync with every rebrand.
   */
  processMatch: string;
  /** the runner's NATIVE (non-OpenAI) API root, where it has one — used for richer status. */
  nativeUrl?: string;
}

export const LOCAL_RUNNERS: readonly LocalRunnerSpec[] = Object.freeze([
  Object.freeze({
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    nativeUrl: "http://localhost:11434",
    host: "localhost",
    port: 11434,
    start: Object.freeze(["ollama", "serve"]),
    processMatch: "ollama",
  }),
  Object.freeze({
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    host: "localhost",
    port: 1234,
    // `lms` is LM Studio's own companion CLI (bundled with the app, or `npx lmstudio install-cli`).
    // VERIFIED against a real install (2026-09): `lms server start --port 1234` brings the API
    // server up headless (it wakes the app in the background if it wasn't already open) — the
    // same shape as `ollama serve`. The explicit `--port` pins it to the port this whole spec
    // assumes, rather than trusting "whatever port it used last time" (`lms`'s own default).
    start: Object.freeze(["lms", "server", "start", "--port", "1234"]),
    // VERIFIED too: `lms server stop` frees the port and leaves the app process running — see
    // LocalRunnerSpec.stop's doc for why this is NOT optional the way it might look. Ollama has
    // no equivalent subcommand, so only this runner sets it.
    stop: Object.freeze(["lms", "server", "stop"]),
    // Best-effort only — see LocalRunnerSpec.processMatch's doc. The real app process on a
    // current build reports as "Bionic" in `ps`, not "LM Studio"; this string is kept as a
    // human-readable fallback label for the (rare) code path with no `stop` command to prefer.
    processMatch: "LM Studio",
  }),
]) as readonly LocalRunnerSpec[];

/**
 * The runner whose base URL matches `url` — LOCAL host and port both (path and trailing slash
 * ignored).
 *
 * The locality check is load-bearing, not defensive tidiness. A `LocalRunnerSpec` is a process
 * we may probe, SPAWN and signal on THIS machine, and `ensureLocalRunnerRunning` works against
 * `runner.baseUrl` (localhost), not the caller's URL. Matching on the port alone therefore meant
 * a remote endpoint on a standard port — `http://gpu-box.lan:11434/v1`, an ordinary supported
 * config — started `ollama serve` plus a detached watchdog on the user's own laptop for a request
 * that was always going to a different host. Same for anything on :1234 (`lms server start`).
 *
 * Deliberately loopback-only (`isLocalUrl`), so an endpoint written as this machine's own LAN
 * address does not autostart either: refusing to spawn is the recoverable direction, spawning a
 * model server nobody asked for is not.
 */
export function runnerForBaseUrl(url: string): LocalRunnerSpec | undefined {
  // `isLocalUrl` is declared below; function declarations hoist, so no reordering is needed.
  if (!isLocalUrl(url)) return undefined;
  const port = portOf(url);
  if (port === undefined) return undefined;
  return LOCAL_RUNNERS.find((r) => r.port === port);
}

/** The runner with this id. */
export function runnerById(id: string): LocalRunnerSpec | undefined {
  return LOCAL_RUNNERS.find((r) => r.id === id);
}

/**
 * The TCP port a base URL points at, defaulting by scheme.
 *
 * Returns undefined for a URL that does not parse rather than guessing: a bad URL must not be
 * silently matched to whichever runner happens to sit on port 80.
 */
export function portOf(url: string): number | undefined {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : undefined;
  } catch {
    return undefined;
  }
}

/** Is this URL pointing at this machine? Only a local server is ours to start or stop. */
export function isLocalUrl(url: string): boolean {
  try {
    // WHATWG `URL#hostname` keeps the brackets on an IPv6 literal ("[::1]", not "::1") — strip
    // them before comparing, or the loopback address never matches.
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
  } catch {
    return false;
  }
}

/**
 * `keep_alive` for a LOCAL model request — how long the runner holds the weights resident
 * after the request completes.
 *
 * This was a hardcoded `"30m"` at five call sites. It silently overrode the user's own standing
 * memory guard: `handoffs/ollama-safe-limits.sh` sets `OLLAMA_KEEP_ALIVE=60s` precisely so a
 * finished chat releases its weights quickly, and a PER-REQUEST `keep_alive` beats the server
 * default. Net effect on a 64 GB Apple Silicon box: a model stayed pinned for 30 minutes after
 * the user stopped typing — one of the documented paths to a black-screen freeze, and it fired
 * even on the 1-token warmup ping.
 *
 * The default is now "60s" — a bound Prometheus applies to ITS OWN requests. That scope is the
 * point: it caps what Prometheus causes the runner to hold, without touching a runner the user
 * drives from their own terminal and without changing any machine-wide setting. Long turns are
 * unaffected, because the runner restarts its idle timer on every request; the 60s only elapses
 * once Prometheus has actually stopped asking.
 *
 * Set `PROMETHEUS_LOCAL_KEEP_ALIVE` to override (e.g. "30m" to pin longer, "" to send nothing
 * and defer entirely to the server).
 */
export const DEFAULT_LOCAL_KEEP_ALIVE = "60s";

export function localKeepAlive(): string | undefined {
  const raw = process.env.PROMETHEUS_LOCAL_KEEP_ALIVE;
  if (raw === undefined) return DEFAULT_LOCAL_KEEP_ALIVE;
  const v = raw.trim();
  return v === "" ? undefined : v;   // explicit empty = opt out, send nothing
}

/**
 * Spread into a local request body. Emits nothing unless the endpoint is local AND a value is
 * explicitly configured — never send a non-standard field to a non-Ollama endpoint.
 */
export function localKeepAliveField(locality: string | undefined): { keep_alive?: string } {
  if (locality !== "local") return {};
  const v = localKeepAlive();
  return v ? { keep_alive: v } : {};
}
