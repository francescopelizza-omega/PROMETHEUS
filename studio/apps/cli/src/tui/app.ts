/**
 * tui/app.ts — the raw-mode interactive controller (the only IO-bearing TUI file).
 *
 * Wires the PURE pieces into a live terminal: raw stdin → decode (keys.ts) → reduce
 * (reducer.ts) → render a frame (frame.ts) → paint inline (redraw.ts); routes the
 * resulting effects to the session backend (session-bridge.ts); pops in-TUI confirm /
 * ask modals; and owns the lifecycle — the sudo gate, SIGWINCH repaint, and an
 * IDEMPOTENT restore wired to every exit/signal/crash path so the terminal is never
 * left in raw mode with a hidden cursor.
 *
 * Everything decision-shaped already lives in the tested pure modules; this file is
 * the thin, crash-guarded glue. A non-TTY (pipe/CI/dumb) returns -1 so bin.ts can fall
 * back to the readline session host.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

import { agent, ai } from "@prometheus/core";
import { frecencyForDirectory } from "@prometheus/core/path-completion";
import type { EngineClient } from "@prometheus/engine-bridge";
import { engineHandshake } from "../doctor-bridge.js";
import { loadSettings, prometheusHome } from "../home.js";
import type { ParsedArgs } from "../parse.js";
import { defaultColorEnabled } from "../render.js";
import { readSavedAuthLevel } from "../session/authorisation-store.js";
import type { Backends } from "../session/onboarding.js";
import { completePath, createPathCycler } from "../session/path-completer.js";
import {
  findProjectRoot,
  loadPathFrecency,
  recordPathUse,
} from "../session/path-frecency-store.js";
import { SLASH_REGISTRY } from "../session/slash-registry.js";
import type { AcItem } from "./autocomplete.js";
import {
  type ModalView,
  applyModalKey,
  modalCursorCol,
  renderFrame,
  renderModal,
} from "./frame.js";
import { clickToOffset } from "./input-box.js";
import { appendInputHistory, inputHistoryPath, loadInputHistory } from "./input-history.js";
import { openInvokeOverlay } from "./invoke-overlay.js";
import { type KeyEvent, decodeKeys } from "./keys.js";
import { type ListOverlayItem, openListOverlay } from "./list-overlay.js";
import { createMarkdownRenderer } from "./markdown.js";
import { type ColorCaps, detectColorCaps, paint, paintDuration } from "./palette.js";
import { workingLine } from "./quantum-verbs.js";
import { BG_BLACK, BG_RESET, ENTER_TUI, RESTORE_TUI, Renderer } from "./redraw.js";
import {
  type ReduceCtx,
  type TuiEffect,
  type TuiState,
  initialTuiState,
  moveCaretTo,
  reduce,
} from "./reducer.js";
import { createSessionBridge } from "./session-bridge.js";
import { traitCells, traitRailFits } from "./status.js";
import { SUDO_ACK_PROMPT, detectElevation, resolveSudoDecision, sudoWarningLines } from "./sudo.js";
import { graphemeCount } from "./width.js";

/** Injection seams (tests / non-default streams). */
/**
 * The authorisation level a fresh TUI session starts at: the LAST-SET persisted level, else the
 * sudo-derived default for the starting mode.
 *
 * `configHome` is the os.homedir()-rooted CONFIG tree, and passing the right one is the entire
 * point of this function existing. The caller used to pass `home` — `prometheusHome()`, the
 * `~/.prometheus` STATE tree — while every writer persists under
 * `cliProfiles.configDir(configHome ?? os.homedir())`. Nothing ever creates
 * `~/.prometheus/.config/prometheus-studio/`, so the read missed on every launch: the level fell
 * back to the default and `setAuthLevel` then wrote that default over the user's real choice,
 * silently downgrading the posture — and the readline host along with it, since the two share the
 * one file. The plain host's own comment records the identical mistake as already fixed there.
 */
export function resolveStartAuthLevel(
  configHome: string | undefined,
  startMode: Parameters<typeof agent.modeToAuthLevel>[0],
): number {
  return readSavedAuthLevel(configHome) ?? agent.modeToAuthLevel(startMode);
}

export interface TuiDeps {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  isTty?: boolean;
  client?: EngineClient;
  /** the `~/.prometheus` STATE tree (accounting, sessions, composer history). */
  home?: string;
  /**
   * The os.homedir()-rooted CONFIG tree that holds `<configHome>/.config/prometheus-studio/`.
   *
   * Distinct from `home` on purpose, and the distinction is the whole bug this field exists to
   * close: the persisted authorisation level is read here and written here, and reading it from
   * `home` instead pointed at a directory that is never created, so the read always missed.
   * Forwarded to `createSessionBridge` so the reader and the writer can never diverge again.
   */
  configHome?: string;
  backends?: Backends;
}

/** The slash registry projected into autocomplete items. */
const AC_ITEMS: AcItem[] = SLASH_REGISTRY.map((c) => ({
  name: c.name,
  summary: c.summary,
  aliases: c.aliases,
  ...(c.args ? { args: c.args } : {}),
  group: c.group,
}));

/** A dim candidate hint row for the folder-prompt modal (CLI-066): `a/ b/ c/  … +N`. */
function candidatesHint(cands: readonly string[]): string {
  if (cands.length === 0) return "";
  const K = 6;
  const shown = cands.slice(0, K).map((c) => {
    const trimmed = c.replace(/\/$/, "");
    const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    return c.endsWith("/") ? `${base}/` : base;
  });
  const more = cands.length - Math.min(K, cands.length);
  return `${shown.join("  ")}${more > 0 ? `  … +${more}` : ""}`;
}

/** Sentinel: not an interactive TTY → caller should use the readline host. */
export const TUI_NOT_TTY = -1;

/**
 * Best-effort persist a crash (an `uncaughtException`/`unhandledRejection` `onCrash` caught) to
 * `<home>/logs/crashes/crash-<timestamp>.log`. Returns the path written, or `""` if the write
 * itself failed — that failure must never block the crash exit it's part of.
 *
 * Split out from `onCrash` (a closure over live terminal/session state that can't be driven from
 * a test) so the actual logging behavior — does it capture the real error, does it land on disk —
 * is unit-testable on its own.
 */
export function logCrash(home: string, err: unknown): string {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    const dir = join(home, "logs", "crashes");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `crash-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    writeFileSync(logPath, `${new Date().toISOString()}\n${detail}\n`);
    return logPath;
  } catch {
    return "";
  }
}

/**
 * Launch the raw-mode TUI. Resolves with the process exit code, or TUI_NOT_TTY when
 * the environment can't host it (the caller then falls back to launchSession).
 */
export async function launchTui(parsed: ParsedArgs, deps: TuiDeps = {}): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const isTty =
    deps.isTty ??
    (stdin.isTTY === true &&
      stdout.isTTY === true &&
      process.env.TERM !== "dumb" &&
      !process.env.CI &&
      typeof stdin.setRawMode === "function");
  if (!isTty) return TUI_NOT_TTY;

  // CLI-097: delegate to render.ts's ONE color predicate (no second divergent detection path).
  const caps: ColorCaps = detectColorCaps(
    process.env,
    !parsed.noColor && !parsed.json && defaultColorEnabled(),
  );

  // ── sudo / root gate (cooked mode, BEFORE we go raw) ─────────────────────── //
  const elevation = detectElevation();
  let startMode: TuiState["permMode"] = "default";
  let bypassLocked = false;
  /** The ceiling the elevated-privilege gate imposes on this session (7 = no ceiling). */
  let maxAuthLevel = agent.MAX_AUTH_LEVEL;
  if (elevation) {
    const red = (s: string): string => (caps === "none" ? s : `\x1b[1;37;41m${s}\x1b[0m`);
    for (const line of sudoWarningLines(elevation).slice(0, -1)) {
      stdout.write(`${line === "" ? "" : red(` ${line} `)}\n`);
    }
    const answer = await new Promise<string>((resolve) => {
      const rl = createInterface({ input: stdin, output: stdout });
      rl.question(`${red(` ${SUDO_ACK_PROMPT} `)} `, (a) => {
        rl.close();
        resolve(a);
      });
    });
    const decision = resolveSudoDecision(elevation, answer);
    startMode = decision.startMode;
    bypassLocked = decision.bypassLocked;
    maxAuthLevel = decision.maxAuthLevel;
    stdout.write(`\n${paint(decision.note, decision.bypassLocked ? "warn" : "info", caps)}\n\n`);
  }

  // ── live state + renderer ────────────────────────────────────────────────── //
  const renderer = new Renderer((s) => stdout.write(s));
  // composer history persisted across restarts (CLI-062): seed ↑/↓ from the on-disk file.
  const home = deps.home ?? prometheusHome();
  // CLI-087: fast cached engine-version handshake — one throttled warn line on a skew/missing
  // engine (before raw mode; never blocks startup). Fire-and-forget-safe (errors swallowed inside).
  try {
    const hs = await engineHandshake({ home });
    if (hs.warning) stdout.write(`${paint(hs.warning, "warn", caps)}\n`);
  } catch {
    /* fail-soft: a handshake hiccup must never stop the TUI from opening */
  }
  // "@"-path completion (see tui/path-mentions.ts): the frecency MEMORY is opt-in (default
  // off, toggled by `/tab-complete`); the store itself is loaded once per project root and
  // cached (a fresh disk read on every keystroke of an open "@"-mention would otherwise
  // re-read the WHOLE frecency file, not just the small settings blob).
  let projectRoot: string | null = null;
  let frecencyStore: ReturnType<typeof loadPathFrecency> | null = null;
  const getFrecencyStore = (): ReturnType<typeof loadPathFrecency> => {
    projectRoot ??= findProjectRoot(process.cwd());
    frecencyStore ??= loadPathFrecency(projectRoot, home);
    return frecencyStore;
  };
  // The enabled flag is re-read from disk (not cached indefinitely) so a mid-session
  // `/tab-complete` toggle takes effect without a restart — but time-boxed, since
  // `frecencyForDir` runs on EVERY keystroke of an open "@"-mention (even ones that reuse
  // the cached directory listing) and the flag essentially never changes mid-keystroke-burst.
  const FRECENCY_SETTING_TTL_MS = 1000;
  let frecencyEnabledCache: { value: boolean; atMs: number } | null = null;
  const isFrecencyEnabled = (): boolean => {
    const now = Date.now();
    if (!frecencyEnabledCache || now - frecencyEnabledCache.atMs > FRECENCY_SETTING_TTL_MS) {
      frecencyEnabledCache = {
        value: loadSettings(home)["completion.pathFrecency"] === true,
        atMs: now,
      };
    }
    return frecencyEnabledCache.value;
  };

  const historyFile = inputHistoryPath(home);
  let state = initialTuiState({
    permMode: startMode,
    bypassLocked,
    history: loadInputHistory(historyFile),
  });
  let size = { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
  let running = false;
  // the live confirm/ask modal (CLI-064): a paint record (not just a boolean) so a SIGWINCH can
  // re-derive + repaint the prompt + typed buffer at the new width. null = no modal open.
  let modal: ModalView | null = null;
  let modalLines = 0; // physical lines the last modal paint occupied (for the repaint move-up).
  /**
   * WHERE the last paint left the cursor, 0-based from the modal's first line.
   *
   * The repaint used to move up `modalLines - 1` unconditionally, i.e. it assumed the cursor was
   * still at the end of the LAST line. It usually is — but when the prompt fits one line and a
   * hint row is present, the block below deliberately moves the cursor back UP to the prompt row
   * so the caret sits in the text. The next keystroke then moved up another `modalLines - 1`
   * from there, overshooting by exactly one row every time and walking the prompt up the screen,
   * repainting over the scrollback above it. The hint row is not hypothetical: the folder prompt
   * shows a live candidate row on every keystroke.
   */
  let modalCursorRow = 0;
  let entered = false;
  let resolveExit: ((code: number) => void) | null = null;

  // key routing: the main composer handler, or a modal's transient handler.
  type KeyHandler = (k: KeyEvent) => void;
  let handler: KeyHandler = mainHandler;

  let lastFrame: ReturnType<typeof renderFrame> | null = null;
  function render(): void {
    if (modal || !entered) return;
    lastFrame = renderFrame({
      state,
      status: session.statusModel(),
      caps,
      cols: size.cols,
      rows: size.rows,
    });
    renderer.paint(lastFrame);
  }

  /**
   * Click-to-position the caret (CLI-069): map the mouse report's absolute (x,y) onto the last
   * frame's composer box, then to a code-point offset via the tested `clickToOffset`. The chrome
   * floats at the BOTTOM of the terminal, so the frame's top row = rows − frame.height + 1.
   */
  function handleClick(m: { x: number; y: number }): void {
    const f = lastFrame;
    if (!f?.box) return;
    const frameTop = Math.max(1, size.rows - f.lines.length + 1);
    /**
     * A click on the trait rail is the MOUSE twin of ⌃T: the first click focuses the cell (the
     * arrows take over from there), a second click on the SAME cell throws its switch. It is the
     * one entry point that needs nothing learned in advance — the rail is already on screen, and
     * the thing you want to change is the thing you click.
     *
     * Checked before the text-area mapping because the rail sits BELOW the body rows: a click
     * there lands past the last wrapped row, where `clickToOffset` would otherwise quietly park
     * the caret at the end of the buffer.
     */
    if (f.rail && m.y - frameTop === f.rail.row) {
      const col = m.x - 1 - f.rail.textLeft;
      const idx = f.rail.spans.findIndex((sp) => col >= sp.start && col < sp.end);
      if (idx >= 0) {
        const cell = traitCells(session.statusModel())[idx];
        if (state.traitFocus?.index === idx && cell?.actionable) {
          dispatch([{ type: "trait-adjust", id: cell.id, delta: cell.state === "on" ? -1 : 1 }]);
        } else {
          state = { ...state, traitFocus: { index: idx } };
        }
        scheduleRender();
      }
      return;
    }
    const bodyRow = m.y - frameTop - f.box.firstBodyRow; // 0-based row within the wrapped text
    const textCol = m.x - 1 - f.box.textLeft; // 0-based display column within the text
    if (bodyRow < 0 || textCol < 0) return; // click outside the text area → ignore
    const offset = clickToOffset(state.input, f.box.textWidth, bodyRow, textCol);
    state = moveCaretTo(state, offset, { items: AC_ITEMS, running }).state;
    scheduleRender();
  }
  let dirty = false;
  function scheduleRender(): void {
    if (dirty || running) return; // during a turn we only print above; no chrome flicker
    dirty = true;
    queueMicrotask(() => {
      dirty = false;
      render();
    });
  }

  // ── the session backend (writes stream ABOVE the chrome) ─────────────────── //
  // Build the backend BEFORE going raw — if it fails (engine locate / detect), fall
  // back to the readline host (the terminal hasn't been touched yet) instead of crashing.
  // one markdown renderer per assistant turn (reset in handleSubmit); tool-framing
  // lines (●/⎿/notices) bypass it and keep the heuristic tint (CLI-020).
  const md = createMarkdownRenderer(caps, Math.max(20, size.cols - 4));
  const renderPaneText = (text: string): string => {
    const out: string[] = [];
    for (const line of text.split("\n")) {
      if (isFramingLine(line)) out.push(paintByHeuristic(line, caps));
      else out.push(...md.feedLine(line));
    }
    return out.join("\n");
  };
  let bridgeInitError: unknown;
  const bridge = await createSessionBridge({
    parsed,
    ...(deps.configHome !== undefined ? { configHome: deps.configHome } : {}),
    write: (text) => {
      renderer.printAbove(renderPaneText(text));
      if (!running) scheduleRender();
    },
    confirm: confirmModal,
    confirmPhrase: confirmPhraseModal,
    ask: askModal,
    askPath: askPathModal, // CLI-066: Tab folder completion + candidate hint row
    /**
     * `/traits` — the typed way into the ⌃T rail mode.
     *
     * Returns false rather than opening an empty mode when the frame is painting no rail (a
     * terminal too short for it, or a model that was never probed): a focus ring on nothing is
     * exactly the "the command did nothing" report this is meant to answer.
     */
    focusTraitRail: () => {
      const cells = traitCells(session.statusModel());
      if (cells.length === 0 || !lastFrame?.rail) return false;
      const first = cells.findIndex((c) => c.actionable);
      state = { ...state, traitFocus: { index: Math.max(0, first) } };
      scheduleRender();
      return true;
    },
    quit: () => finish(0),
    // The fleet bar moves on its own clock — a peer dying, or one entering `needs-you` — and a
    // status line that only refreshes on a keystroke cannot report an event whose whole purpose
    // is to reach a user who is not typing.
    redraw: () => scheduleRender(),
    caps,
    // stream word-wrap width: cols-1 dodges the last-column autowrap glitch (?7l region).
    width: () => Math.max(20, size.cols - 1),
    // `prometheus --continue` resumes the newest past session on startup (CLI-013).
    continueSession: parsed.flags.continue === true,
    ...(deps.client ? { client: deps.client } : {}),
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.backends ? { backends: deps.backends } : {}),
  }).catch((err: unknown) => {
    bridgeInitError = err;
    return null;
  });
  if (!bridge) {
    // NOT a non-TTY environment — that already returned TUI_NOT_TTY above, silently, by design
    // (a pipe/CI/dumb-term fallback needs no explanation). This is the modern TUI's OWN backend
    // setup throwing (a bad hooks/settings file, a home-tree permission hiccup, …), which used to
    // downgrade to the readline host with the EXACT SAME silent sentinel — so a user landed on a
    // surface with no real modals/pickers and no way to know why "the menus don't work like they
    // used to." The terminal hasn't gone raw yet, so a plain write here is safe.
    const reason =
      bridgeInitError instanceof Error ? bridgeInitError.message : String(bridgeInitError);
    stdout.write(
      `${paint(
        `⚠ Prometheus's modern terminal UI failed to start (${reason}) — continuing in compatibility mode; interactive pickers are unavailable there.`,
        "warn",
        caps,
      )}\n`,
    );
    return TUI_NOT_TTY;
  }
  const session = bridge; // non-null alias so the closures below don't see `| null`

  // --authorisation(s) / --authorization(s): the 0–7 autonomy scale (a digit OR a name,
  // e.g. `--authorisation 7` or `--authorisation runall`). Sets the starting mode AND the
  // fine-grained per-tool auth level. A declined-sudo bypass lock caps it below trusted.
  const authFlag =
    parsed.flags.authorisations ??
    parsed.flags.authorisation ??
    parsed.flags.authorizations ??
    parsed.flags.authorization ??
    // `--auth` was a slash ALIAS but never a flag alias, so `--auth 7` parsed and did nothing.
    parsed.flags.auth;
  // default = the LAST-SET level persisted from any prior session (so the user's chosen posture
  // carries across sessions); falls back to the sudo-derived mode when never set. A flag overrides.
  /**
   * `--permission-mode <mode>` — parsed by parse.ts, and read by NOBODY until now.
   *
   * `prometheus --permission-mode plan` was accepted in silence and started an ordinary session,
   * on every host. It is applied here, ahead of the authorisation flag so an explicit
   * `--authorisation N` still wins when both are given, and SESSION-SCOPED like every other
   * launch flag. A declined sudo gate forbids the bypass tiers, so those are refused with a note
   * rather than silently downgraded.
   */
  const modeFlag = parsed.flags["permission-mode"] ?? parsed.flags.permissionMode;
  let modeFlagApplied = false;
  if (typeof modeFlag === "string") {
    const wanted = agent.PERMISSION_MODES.find((m) => m.id === modeFlag.trim());
    if (!wanted) {
      const legend = agent.PERMISSION_MODES.map((m) => m.id).join(" · ");
      stdout.write(
        `${paint(`unknown --permission-mode "${modeFlag}" — use one of: ${legend}`, "warn", caps)}\n`,
      );
    } else if (bypassLocked && (wanted.id === "bypassPermissions" || wanted.id === "yolo")) {
      stdout.write(
        `${paint(`--permission-mode ${wanted.id} is locked (elevated-privilege decline)`, "warn", caps)}\n`,
      );
    } else {
      startMode = wanted.id;
      modeFlagApplied = true;
    }
  }
  let startAuthLevel = resolveStartAuthLevel(deps.configHome, startMode);
  // An explicit `--permission-mode` OVERRIDES the stored default — otherwise the saved level
  // would win and the flag would be inert on exactly the machines that have ever used it.
  if (modeFlagApplied) startAuthLevel = agent.modeToAuthLevel(startMode);
  if (authFlag !== undefined) {
    const parsedLevel = typeof authFlag === "string" ? agent.parseAuthLevel(authFlag) : null;
    if (parsedLevel === null) {
      stdout.write(
        `${paint(
          `unknown --authorisation "${authFlag === true ? "" : authFlag}" — use a level 0–7 or a name: ${agent.authLevelLegend()}`,
          "warn",
          caps,
        )}\n`,
      );
    } else {
      startAuthLevel = parsedLevel;
    }
  }
  // The post-sudo cap comes from the gate's own decision (sudo.ts `maxAuthLevel`), so the note
  // the user was shown and the posture they actually get are produced by one object. The old
  // hand-written `> 5 → 5` left a DECLINED root session auto-approving installs.
  const authLevelBeforeClamp = startAuthLevel;
  if (startAuthLevel > maxAuthLevel) startAuthLevel = maxAuthLevel;
  /**
   * `session`, never `user`: restoring the saved level, applying a launch flag and clamping after
   * a declined sudo gate are all things that happen TO the session, not choices the operator
   * typed. This call used to persist unconditionally, which is what made every one of them
   * permanent — a single `sudo prometheus` with a declined acknowledgement rewrote a saved
   * level 7 to 5 on disk, for every future session on the machine.
   *
   * `setAuthLevel` DERIVES the mode from the level, and mode↔level is lossy both ways, so an
   * explicit `--permission-mode` cannot survive it: plan pins the level to 0 and level 0 maps
   * back to "default", while `plan --authorisation 7` came out as "yolo" — read-only exploration
   * turned into full-autonomy run-to-done. `setPosture` writes the two fields independently, so
   * an explicitly named mode is used only when the flag really named one AND the sudo clamp did
   * not have to move the level (a clamp is a safety decision and outranks the flag).
   */
  if (modeFlagApplied && startAuthLevel === authLevelBeforeClamp) {
    session.setPosture(startMode, startAuthLevel);
  } else {
    session.setAuthLevel(startAuthLevel, "session"); // sets the level AND syncs the coarse mode
  }
  /**
   * Push the derived posture into the REDUCER's state too.
   *
   * `state.permMode` is what the status chip paints and what Shift-Tab cycles FROM, and it was
   * only ever initialised from `startMode` — so a restored level 7 rendered "auth:7·runall" beside
   * a `[PROMETHEUS:DEFAULT]` chip, and the first Shift-Tab advanced from `default` (the stale
   * value) to `acceptEdits`, dropping the user to level 2 instead of moving on from `yolo`.
   */
  state = { ...state, permMode: session.getPermMode() };
  if (authFlag !== undefined) {
    const m = agent.authLevelMeta(startAuthLevel);
    stdout.write(
      `${paint(`authorisation: ${m.level} ${m.name} — ${m.description}`, "info", caps)}\n`,
    );
  }

  // ── raw mode setup + restore ─────────────────────────────────────────────── //
  function restore(): void {
    if (!entered) return;
    entered = false;
    try {
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      if (caps !== "none") stdout.write(BG_RESET); // restore the terminal's own background
      stdout.write(RESTORE_TUI);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdin.off("end", onHangup);
      stdin.off("close", onHangup);
      stdin.off("error", onHangup);
      stdout.off("error", onHangup);
      stdout.off("resize", onResize);
    } catch {
      /* best-effort restore — never throw out of cleanup */
    }
    process.off("exit", restore);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
  }
  function onSignal(): void {
    finish(130);
  }
  /**
   * THE TERMINAL GOING AWAY IS AN EXIT CONDITION.
   *
   * Only `data` used to be handled, so when the tty died under us — window closed, ssh
   * dropped, parent shell killed — stdin's `end`/`error` (EIO on a dead pty) went nowhere:
   * the TUI stayed alive, reparented to launchd, spinning a full core on reads of a dead
   * fd. Measured on this machine: PPID 1, state R, 99.9% CPU, 109 MB RSS, climbing until
   * killed by hand. SIGHUP is not reliably delivered in that situation, so these stream
   * events — not the signal — are what tells us the terminal is gone.
   *
   * 129 = 128 + SIGHUP, the conventional status for exactly this.
   */
  function onHangup(): void {
    finish(129);
  }
  // A crash (uncaughtException / unhandledRejection) must not merely restore the
  // terminal and return — that leaves the exit promise UNRESOLVED and the host hung.
  // finish(1) restores AND resolves with a non-zero code so the caller exits cleanly.
  //
  // `onCrash` used to take no argument at all: registered directly as the
  // `uncaughtException`/`unhandledRejection` listener, it silently dropped the error Node
  // handed it. The terminal was restored and the process exited clean — with ZERO trace of
  // what actually threw, anywhere. A crash left no log, no stack, nothing to diagnose after
  // the fact. This writes the error to a crash log FIRST, before the terminal teardown that
  // `finish` performs, then prints a one-line pointer to it once the terminal is restored
  // (printed while the alt-screen buffer is still up would otherwise never be seen).
  function onCrash(err: unknown): void {
    const logPath = logCrash(home, err);
    finish(1);
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `\nPrometheus crashed: ${message}${logPath ? `\n  details: ${logPath}` : ""}\n`,
    );
  }
  function finish(code: number): void {
    if (resolveExit === null) return;
    renderer.clear();
    restore();
    stdout.write("\n");
    // Release the session's MCP transports. Fire-and-forget: the terminal is already restored
    // and the user is leaving — a connector that is slow to die must not hold the exit — but
    // WITHOUT this the connector subprocesses simply outlive the session.
    void session.dispose().catch(() => {});
    const r = resolveExit;
    resolveExit = null;
    r(code);
  }

  // ── input decoding (UTF-8 safe + split-sequence rest buffer + ESC timer) ─── //
  const decoder = new StringDecoder("utf8");
  let restBuf = "";
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  function onData(chunk: Buffer): void {
    const data = restBuf + decoder.write(chunk);
    const { events, rest } = decodeKeys(data);
    restBuf = rest;
    // a malformed/never-completing escape sequence would otherwise grow restBuf without
    // bound; real key sequences are a handful of bytes, so cap and drop the stuck prefix.
    if (restBuf.length > 1024 && restBuf !== "\x1b") restBuf = "";
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    for (const k of events) handler(k);
    // a lone trailing ESC: flush it as the Escape key after a short grace window.
    if (restBuf === "\x1b") {
      escTimer = setTimeout(() => {
        restBuf = "";
        handler({ name: "esc" });
      }, 50);
    }
  }
  function onResize(): void {
    size = { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
    // CLI-064: a resize while a modal is open must repaint the MODAL region (the chrome stays
    // frozen), not no-op through render() — otherwise the prompt is lost mid-decision.
    if (modal) {
      paintModal();
      return;
    }
    // the paint moves up by the parked caret row + erases, so the old (autowrap-off,
    // non-reflowed) block is wiped cleanly at the new width — no reset(), no debris.
    render();
  }

  /**
   * Paint (or repaint) the open modal via the pure `renderModal` helper (CLI-064): return to the
   * modal's first line, erase to end of screen (clears stale autowrap debris at a narrower width),
   * then rewrite the width-clamped prompt + buffer. Shared by first-paint, keystroke, and resize.
   */
  function paintModal(): void {
    if (!modal) return;
    const lines = renderModal(modal, size.cols, caps);
    try {
      // move to the start of the modal's first physical line, then wipe from there down.
      // Up from where the cursor ACTUALLY is, not from where a full-height paint would leave it.
      if (modalCursorRow > 0) safeWrite(`\r\x1b[${modalCursorRow}A`);
      else safeWrite("\r");
      safeWrite("\x1b[0J"); // erase cursor→end-of-screen (removes wrapped remnants)
      safeWrite(lines.join("\r\n"));
      modalLines = lines.length;
      modalCursorRow = lines.length - 1; // the write left the cursor on the last line
      // CLI-065/066: reposition the cursor to the caret column on the PROMPT line (row 0) — works
      // with an optional hint row (CLI-066) below the prompt. Only when the prompt itself fits one
      // line (the common case; a wrapped prompt leaves the cursor at the end).
      const promptRows = lines.length - (modal.hint ? 1 : 0);
      if (promptRows === 1) {
        if (lines.length > 1) safeWrite(`\x1b[${lines.length - 1}A`); // back up to the prompt row
        modalCursorRow = 0; // …and the next repaint must start from HERE
        safeWrite("\r");
        const col = modalCursorCol(modal);
        if (col > 0) safeWrite(`\x1b[${col}C`);
      }
    } catch {
      /* broken sink — ignore, the modal handler stays usable */
    }
  }

  // ── the main composer key handler ────────────────────────────────────────── //
  function mainHandler(k: KeyEvent): void {
    // CLI-069: a left-button press positions the caret (needs the frame layout); the wheel falls
    // through to the reducer (dropdown nav). Other mouse events are ignored.
    if (k.name === "mouse" && k.mouse && !k.mouse.wheel) {
      if (k.mouse.pressed && k.mouse.button === 0) handleClick(k.mouse);
      return;
    }
    const ctx: ReduceCtx = {
      items: AC_ITEMS,
      running,
      /**
       * The rail the CURRENT frame is painting — ⌃T focuses a real cell, and ↑/↓ can tell a
       * switch from an indicator instead of guessing.
       *
       * OMITTED when the rail does not fit, which is the contract `ReduceCtx.traitCells`
       * documents ("Omitted ⇒ no rail is being painted, and ⌃T falls back to its historical
       * blind tools flip"). It was passed unconditionally, so on a narrow terminal — the rail is
       * ~35-38 columns and `traitRailLine` drops it rather than paint a truncated row — ⌃T
       * entered its MODAL focus with nothing on screen: no rail, no focus ring, no hint row, and
       * every printable key, Enter, Backspace and ⌃D swallowed by the modal reducer. That reads
       * as a frozen terminal. `traitRailFits` is the same predicate the painter uses.
       */
      ...(traitRailFits(traitCells(session.statusModel()), Math.max(0, size.cols - 5))
        ? { traitCells: traitCells(session.statusModel()) }
        : {}),
      pathCompletion: {
        baseDir: process.cwd(),
        frecencyForDir: (dirPath) =>
          isFrecencyEnabled()
            ? frecencyForDirectory(getFrecencyStore(), dirPath, Date.now())
            : new Map(),
      },
    };
    const { state: next, effects } = reduce(state, k, ctx);
    state = next;
    dispatch(effects);
    scheduleRender();
  }

  let submitChain: Promise<void> = Promise.resolve();
  // per-turn abort handle — Ctrl-C during a running turn aborts THIS controller.
  let turnAbort: AbortController | null = null;
  function dispatch(effects: TuiEffect[]): void {
    for (const e of effects) {
      switch (e.type) {
        case "submit":
          // persist the submitted line for cross-restart ↑/↓ (CLI-062); secrets/empties skipped,
          // adjacent dups deduped on disk. Fire-and-forget, never blocks/breaks the submit.
          appendInputHistory(historyFile, e.text);
          // keep the chain alive on failure: a rejected handleSubmit must not poison
          // every later submit, nor surface as an unhandledRejection (→ onCrash).
          submitChain = submitChain
            .then(() => handleSubmit(e.text))
            .catch((err: unknown) => {
              renderer.printAbove(
                paint(
                  `submit failed: ${err instanceof Error ? err.message : String(err)}`,
                  "danger",
                  caps,
                ),
              );
            });
          break;
        case "exit":
          finish(e.code);
          break;
        case "interrupt":
          // actually cancel the in-flight turn (SSE stream + tool loop), not just print.
          turnAbort?.abort();
          renderer.printAbove(paint("(interrupted)", "warn", caps));
          break;
        case "redraw-full":
          renderer.reset();
          render();
          break;
        case "mode-changed":
          session.setPermMode(e.mode);
          renderer.printAbove(paint(`▸ permission mode: ${e.mode} — ${e.note}`, "info", caps));
          scheduleRender();
          break;
        case "notice":
          renderer.printAbove(paint(e.text, "muted", caps));
          scheduleRender();
          break;
        case "tools-toggle": {
          const on = session.toggleTools();
          renderer.printAbove(paint(`⚒ tools ${on ? "ON" : "OFF"}`, on ? "info" : "warn", caps));
          scheduleRender();
          break;
        }
        case "trait-adjust": {
          /**
           * The trait rail's ↑/↓ (⌃T mode) land here, where the session tuning actually lives.
           *
           * `think` and the effort cell are the same switch seen from two sides: thinking OFF is
           * the tier `off`, and turning it back on has to restore the tier the user was last at
           * rather than a hard-coded default — otherwise a glance at the rail silently demotes a
           * `max` session. The rail repaints from `statusModel()` on the next frame, so there is
           * no second copy of this state to keep in sync.
           */
          const on = e.delta > 0;
          /**
           * Report a CHANGE, never a keypress.
           *
           * Every press used to print a line, including one that changed nothing — `stepEffort`
           * clamps at both ends, so holding ↓ at `off` (or ↑ at `max`) emitted the same line
           * again and again. A real session showed `effort off / effort off` and
           * `effort max / effort max` stacked in the scrollback, which reads as a setting
           * flapping rather than one that had reached its limit and stayed put.
           */
          const before = session.statusModel();
          if (e.id === "tools") {
            const now = session.setToolsEnabled(on);
            if (now !== before.tools) {
              renderer.printAbove(
                paint(`⚒ tools ${now ? "ON" : "OFF"}`, now ? "info" : "warn", caps),
              );
            }
          } else if (e.id === "thinking") {
            const tier = on ? session.resumeThinking() : session.setEffort("off");
            if (tier !== before.effort?.tier) {
              renderer.printAbove(
                paint(
                  `◆ thinking ${tier === "off" ? "OFF" : `ON (effort ${tier})`}`,
                  on ? "info" : "warn",
                  caps,
                ),
              );
            }
          } else if (e.id === "effort") {
            const tier = session.stepEffort(e.delta);
            if (tier !== before.effort?.tier) {
              renderer.printAbove(
                paint(`◆ effort ${tier}`, tier === "off" ? "warn" : "info", caps),
              );
            }
          }
          scheduleRender();
          break;
        }
        case "invoke-dispatch": {
          // the overlay picked an entry + args → run the SAME nemesis-gated install (CLI-059).
          const { name, args } = e;
          submitChain = submitChain
            .then(() => session.invokeInstall(name, args))
            .catch((err: unknown) => {
              renderer.printAbove(
                paint(
                  `invoke failed: ${err instanceof Error ? err.message : String(err)}`,
                  "danger",
                  caps,
                ),
              );
            })
            .then(() => scheduleRender());
          break;
        }
        case "list-pick":
          // the overlay's own pick — resubmit its text through the NORMAL composer path
          // (CLI-1xx), exactly as if the user had typed it: no separate execution logic here.
          dispatch([{ type: "submit", text: e.text }]);
          break;
        case "pane-changed":
          // Ctrl+G (CLI-060/067): the ⊞ status chip already reflects it; flash the new pane too.
          renderer.printAbove(paint(`⊞ pane: ${e.pane}`, "info", caps));
          scheduleRender();
          break;
        case "save-transcript": {
          // Ctrl+S (CLI-067): reuse the existing export flow + flash the ABSOLUTE written path.
          const savedTo = session.slashCtx.exportTranscript();
          renderer.printAbove(
            paint(
              savedTo ? `💾 transcript saved → ${savedTo}` : "save failed",
              savedTo ? "info" : "warn",
              caps,
            ),
          );
          scheduleRender();
          break;
        }
        case "copy-reply":
          // Ctrl+Y (CLI-068): the OSC 52 raw write happens inside copyToClipboard; flash the status.
          renderer.printAbove(paint(session.slashCtx.copyToClipboard(), "info", caps));
          scheduleRender();
          break;
        case "path-completed":
          // an "@"-path resolved to a FILE — remember it (opt-in; see getFrecencyStore above).
          if (isFrecencyEnabled()) {
            projectRoot ??= findProjectRoot(process.cwd());
            frecencyStore = recordPathUse(projectRoot, e.path, Date.now(), home);
          }
          break;
      }
    }
  }

  /** Open a generic pick-one overlay + repaint; the shared tail of every bare-command branch below. */
  function openPicker(title: string, items: ListOverlayItem[]): void {
    state = { ...state, listOverlay: openListOverlay(title, items) };
    scheduleRender();
  }

  async function handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    // bare pick-a-thing commands open a real arrow-nav overlay instead of their numbered/static
    // fallback (CLI-1xx) — `/agents 4`, `/think high`, `/model <id>` and every non-TTY host keep
    // their existing typed-argument behavior unchanged; only the ARGUMENT-LESS form is special-
    // cased here, exactly like `/invoke` below.
    if (trimmed === "/agents" || trimmed === "/subagents" || trimmed === "/team") {
      const current = session.slashCtx.agents.count();
      openPicker(
        "Subagent fan-out — pick 1–16",
        Array.from({ length: 16 }, (_, i) => {
          const n = i + 1;
          return { label: String(n), current: n === current, submitText: `/agents ${n}` };
        }),
      );
      return;
    }
    if (trimmed === "/think" || trimmed === "/effort") {
      const current = session.slashCtx.tuning().effort;
      /**
       * Every rung the ladder HAS, with what the bound model will actually do with it.
       *
       * The list was a hard-coded five, so the two rungs the ladder grew — the ones a paid
       * Claude or GPT model charges for and a person is most likely to want — could not be
       * picked here at all. Reading `EFFORT_TIERS` means the picker cannot fall behind again.
       *
       * The `detail` is the honest half: a rung this model cannot express is still OFFERED (it
       * is a preference, and it applies the moment you switch to a model that has it) but it
       * says up front what it will resolve to here, rather than accepting the choice and
       * quietly sending something else.
       */
      openPicker(
        "Reasoning effort",
        ai.EFFORT_TIERS.map((tier) => {
          const res = session.slashCtx.effortResolution?.(tier);
          /**
           * `applied === null` FIRST — it is the case the annotation exists for.
           *
           * `resolveEffort` returns `applied: null` for exactly the tiers a model cannot express
           * (`no-capability`, `always-on`), and both old arms required a non-null `applied`. So
           * the unexpressible rungs rendered identically to fully supported ones: the picker
           * accepted `max` and nothing changed on any turn — the silent acceptance the docblock
           * above says this feature removes. The `reason` slug is never shown raw.
           */
          const detail = !res
            ? undefined
            : res.applied === null
              ? res.degraded?.reason === "always-on"
                ? "no effect — this model always reasons at a fixed depth"
                : "not available on this model"
              : res.applied !== tier
                ? `→ ${res.applied} on this model`
                : res.degraded?.reason === "emulated"
                  ? "by instruction (this model has no knob)"
                  : res.degraded?.reason === "forced"
                    ? "forced onto the wire — the provider may reject it"
                    : undefined;
          return {
            label: tier,
            current: tier === current,
            ...(detail ? { detail } : {}),
            submitText: `/think ${tier}`,
          };
        }),
      );
      return;
    }
    if (trimmed === "/commands" || trimmed === "/cmds") {
      openPicker(
        "Commands",
        AC_ITEMS.map((it) => ({
          label: `/${it.name}`,
          detail: it.summary,
          submitText: `/${it.name}`,
        })),
      );
      return;
    }
    if (trimmed === "/model" || trimmed === "/worker") {
      const candidates = session.slashCtx.modelPicker?.candidates() ?? [];
      if (candidates.length === 0) {
        renderer.printAbove(
          paint(
            "/model: no switchable models detected — run /setup to download a local model (or start it, if you already have one installed) or configure a cloud key.",
            "warn",
            caps,
          ),
        );
        return;
      }
      openPicker(
        "Active model",
        candidates.map((cand) => ({
          label: cand.label,
          detail: cand.detail,
          current: cand.current,
          submitText: `/model ${cand.id}`,
        })),
      );
      return;
    }
    // bare `/invoke` in the TTY opens the arrow-nav overlay (CLI-059) instead of the number-pick;
    // `/invoke <filter>` and every non-TTY host keep the number-pick list unchanged.
    if (text.trim() === "/invoke") {
      const items = await session.invokeCatalog();
      if (items.length === 0) {
        renderer.printAbove(paint("/invoke: catalog empty or unavailable", "warn", caps));
        return;
      }
      state = { ...state, invokeOverlay: openInvokeOverlay(items) };
      scheduleRender();
      return;
    }
    running = true;
    turnAbort = new AbortController();
    md.reset(); // fresh markdown state per turn (no fence bleed, CLI-020)
    renderer.printAbove(paint(`› ${text}`, "question", caps));
    // live "working…" spinner: a quantum-physics verb + braille frame + elapsed, painted in
    // place BELOW the streamed output. Off under caps='none' (piped/NO_COLOR stays clean).
    const spinStart = Date.now();
    const spinSeed = spinStart % 40; // vary the opening verb per turn
    let spinTick = 0;
    const spin: ReturnType<typeof setInterval> | null =
      caps === "none"
        ? null
        : setInterval(() => {
            // CRITICAL (CLI-064): a confirm/ask modal opened mid-turn (e.g. the write_file
            // permission prompt) paints ONCE; if the spinner keeps drawing it OVERWRITES the
            // prompt every 120ms so the user never sees it and the turn appears to hang while
            // silently waiting for input. Skip the spinner frame whenever a modal is open.
            if (modal) return;
            renderer.transient(workingLine(spinTick++, Date.now() - spinStart, caps, spinSeed));
          }, 120);
    try {
      await session.submit(text, { signal: turnAbort.signal });
    } catch (err) {
      renderer.printAbove(
        paint(`error: ${err instanceof Error ? err.message : String(err)}`, "danger", caps),
      );
    } finally {
      if (spin) clearInterval(spin);
      /**
       * Re-sync the reducer's posture from the bridge after EVERY submitted line.
       *
       * `/authorisation 6` and `/permission-mode plan` move the bridge's `permMode`; the reducer
       * kept its own copy, which is the one the status chip paints and the one Shift-Tab cycles
       * from. Without this the chip reported a posture the session had already left, and the
       * next Shift-Tab advanced from that stale value — silently undoing the command the user
       * had just typed.
       */
      state = { ...state, permMode: session.getPermMode() };
    }
    // close an unterminated fence at turn end so the box always finishes.
    const tail = md.flush();
    if (tail.length > 0) renderer.printAbove(tail.join("\n"));
    // elapsed-time resume: only the non-zero counters, e.g. "40s" / "1m 30s". Painted BOLD in a
    // hue that reports how long the turn ran (light blue under 30m … purple past 7h) — the old
    // `muted` grey was the least readable colour on the palette for the one line that is a
    // verdict on the turn.
    const elapsedMs = Date.now() - spinStart;
    renderer.printAbove(paintDuration(`⏱ ${agent.formatDuration(elapsedMs)}`, elapsedMs, caps));
    turnAbort = null;
    running = false;
    render();
  }

  // ── in-TUI modals (a transient key handler over the same stdin) ──────────── //
  /** Safely write to stdout; a broken pipe must never abort a modal mid-prompt. */
  function safeWrite(s: string): void {
    try {
      stdout.write(s);
    } catch {
      /* broken sink — ignore */
    }
  }
  function confirmModal(prompt: string): Promise<boolean> {
    return new Promise((resolve) => {
      // assign the handler + record BEFORE any I/O so a write failure can't strand the
      // modal with the chrome frozen (handler stays usable).
      const done = (yes: boolean): void => {
        handler = mainHandler;
        modal = null;
        modalLines = 0;
        modalCursorRow = 0;
        modalCursorRow = 0;
        safeWrite("\n"); // move off the modal region
        scheduleRender();
        resolve(yes);
      };
      handler = (k) => {
        const yes = k.name === "char" && (k.ch === "y" || k.ch === "Y");
        if (k.name === "enter" || k.name === "char" || k.name === "esc" || k.name === "ctrl-c") {
          done(yes);
        }
      };
      modal = { kind: "confirm", prompt, buffer: "", caret: 0 };
      modalLines = 0;
      modalCursorRow = 0;
      try {
        renderer.clear(); // move to the (frozen) chrome top; the modal paints from there
        paintModal(); // width-aware first paint, shared with the resize repaint (CLI-064)
      } catch {
        done(false); // I/O failed before the prompt rendered → deny + recover
      }
    });
  }
  function confirmPhraseModal(prompt: string, phrase: string): Promise<boolean> {
    return askModal(prompt).then((a) => a.trim() === phrase);
  }
  function askModal(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const done = (value: string): void => {
        handler = mainHandler;
        modal = null;
        modalLines = 0;
        modalCursorRow = 0;
        modalCursorRow = 0;
        safeWrite("\n");
        scheduleRender();
        resolve(value);
      };
      handler = (k) => {
        if (!modal) return;
        if (k.name === "enter") {
          done(modal.buffer);
        } else if (k.name === "ctrl-c" || k.name === "esc") {
          done("");
        } else {
          // CLI-065: grapheme- + caret-aware edit (left/right/home/end/backspace/delete/char/paste);
          // repaint the whole modal so display can never desync from the buffer (no raw `\b \b`).
          modal = applyModalKey(modal, k);
          paintModal();
        }
      };
      modal = { kind: "ask", prompt, buffer: "", caret: 0 };
      modalLines = 0;
      modalCursorRow = 0;
      try {
        renderer.clear();
        paintModal();
      } catch {
        done(""); // I/O failed before the prompt rendered → empty + recover
      }
    });
  }

  /**
   * A folder-prompt modal (CLI-066): the ask modal + real Tab completion via the tested path
   * cycler (dirs-only, common-prefix-then-cycle) with a dim candidate hint row. Empty answer → def.
   */
  function askPathModal(prompt: string, def: string): Promise<string> {
    return new Promise((resolve) => {
      const cycler = createPathCycler(undefined, true); // real fs, directory-only
      const done = (value: string): void => {
        handler = mainHandler;
        modal = null;
        modalLines = 0;
        modalCursorRow = 0;
        modalCursorRow = 0;
        safeWrite("\n");
        scheduleRender();
        resolve(value);
      };
      handler = (k) => {
        if (!modal) return;
        if (k.name === "enter") {
          done(modal.buffer.trim() || def);
        } else if (k.name === "ctrl-c" || k.name === "esc") {
          done("");
        } else if (k.name === "tab") {
          const { buffer, candidates } = cycler.tab(modal.buffer);
          modal = {
            ...modal,
            buffer,
            caret: graphemeCount(buffer),
            hint: candidatesHint(candidates),
          };
          paintModal();
        } else {
          cycler.reset(); // any edit resets the cycle
          const edited = applyModalKey(modal, k);
          // LIVE preview, not Tab-only: the candidate row is what tells the user their path is
          // going somewhere real, and withholding it until Tab is pressed is why the completion
          // read as "not there". Fail-soft — an unreadable directory yields no candidates.
          let hint = "";
          try {
            hint = candidatesHint(completePath(edited.buffer, undefined, { dirsOnly: true })[0]);
          } catch {
            hint = "";
          }
          modal = { ...edited, hint };
          paintModal();
        }
      };
      // seed the candidate row from the empty buffer, so the folder list is on screen BEFORE
      // the first keystroke rather than only after a Tab nobody knew to press.
      let seed = "";
      try {
        seed = candidatesHint(completePath("", undefined, { dirsOnly: true })[0]);
      } catch {
        seed = "";
      }
      modal = {
        kind: "ask",
        prompt: `${prompt} (default ${def})`,
        buffer: "",
        caret: 0,
        hint: seed,
      };
      modalLines = 0;
      modalCursorRow = 0;
      try {
        renderer.clear();
        paintModal();
      } catch {
        done(def);
      }
    });
  }

  // ── go raw + first paint ─────────────────────────────────────────────────── //
  return await new Promise<number>((resolve) => {
    resolveExit = resolve;
    // mark `entered` the instant raw mode is on, BEFORE any write — so restore() always
    // un-raws the tty even if ENTER_TUI / the first paint throws (terminal never stuck).
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    entered = true;
    stdin.resume();
    stdout.write(ENTER_TUI);
    // force a pure-black background for best Pelly-color contrast (skipped under NO_COLOR).
    if (caps !== "none") stdout.write(BG_BLACK);
    stdin.on("data", onData);
    stdin.on("end", onHangup);
    stdin.on("close", onHangup);
    stdin.on("error", onHangup);
    stdout.on("error", onHangup); // the write half can die first (EPIPE on a closed pty)
    stdout.on("resize", onResize);
    // restore the terminal on EVERY exit path — normal, signal, or crash. (bin.ts's
    // process-level guards still log; these just un-raw the tty so it's never stuck.)
    process.on("exit", restore);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);

    // banner + onboarding into scrollback, then the first chrome paint. Guard the
    // first I/O: if it throws, restore the tty + exit cleanly rather than leaving raw.
    try {
      renderer.printAbove(session.banner());
      render();
    } catch {
      finish(1);
    }
  });
}

/**
 * Heuristic role for a streamed backend line so the high-contrast palette underlines
 * each output type (commands, +/- diff lines, verdicts, errors). A no-op under
 * tier=none. The bridge already prefixes tool framing (`●`/`⎿`); we tint by shape.
 */
/** Tool-framing / notice lines bypass markdown (keep the heuristic tint), CLI-020. */
function isFramingLine(line: string): boolean {
  const t = line.trimStart();
  return /^[●⎿ℹ▸🛸↩⚒↻✎]/u.test(t) || t.startsWith("$ ") || t.startsWith("› ");
}

function paintByHeuristic(text: string, caps: ColorCaps): string {
  if (caps === "none") return text;
  return text
    .split("\n")
    .map((line) => {
      const t = line.trimStart();
      if (t.startsWith("$ ") || t.startsWith("● ")) return paint(line, "command", caps);
      if (t.startsWith("+")) return paint(line, "codeAdd", caps);
      if (t.startsWith("-")) return paint(line, "codeDel", caps);
      if (/\b(error|failed|blocked|BLOCK)\b/i.test(t)) return paint(line, "danger", caps);
      if (/\b(warn|warning|caution)\b/i.test(t)) return paint(line, "warn", caps);
      if (t.startsWith("⎿") || t.startsWith("ℹ") || t.startsWith("▸"))
        return paint(line, "info", caps);
      return line;
    })
    .join("\n");
}
