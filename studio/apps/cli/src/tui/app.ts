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
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

import type { EngineClient } from "@prometheus/engine-bridge";
import { engineHandshake } from "../doctor-bridge.js";
import { prometheusHome } from "../home.js";
import type { ParsedArgs } from "../parse.js";
import { defaultColorEnabled } from "../render.js";
import type { Backends } from "../session/onboarding.js";
import { createPathCycler } from "../session/path-completer.js";
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
import { createMarkdownRenderer } from "./markdown.js";
import { type ColorCaps, detectColorCaps, paint } from "./palette.js";
import { workingLine } from "./quantum-verbs.js";
import { ENTER_TUI, RESTORE_TUI, Renderer } from "./redraw.js";
import {
  type ReduceCtx,
  type TuiEffect,
  type TuiState,
  initialTuiState,
  moveCaretTo,
  reduce,
} from "./reducer.js";
import { createSessionBridge } from "./session-bridge.js";
import { SUDO_ACK_PROMPT, detectElevation, resolveSudoDecision, sudoWarningLines } from "./sudo.js";
import { graphemeCount } from "./width.js";

/** Injection seams (tests / non-default streams). */
export interface TuiDeps {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  isTty?: boolean;
  client?: EngineClient;
  home?: string;
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
  const bridge = await createSessionBridge({
    parsed,
    write: (text) => {
      renderer.printAbove(renderPaneText(text));
      if (!running) scheduleRender();
    },
    confirm: confirmModal,
    confirmPhrase: confirmPhraseModal,
    ask: askModal,
    askPath: askPathModal, // CLI-066: Tab folder completion + candidate hint row
    quit: () => finish(0),
    caps,
    // stream word-wrap width: cols-1 dodges the last-column autowrap glitch (?7l region).
    width: () => Math.max(20, size.cols - 1),
    // `prom --continue` resumes the newest past session on startup (CLI-013).
    continueSession: parsed.flags.continue === true,
    ...(deps.client ? { client: deps.client } : {}),
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.backends ? { backends: deps.backends } : {}),
  }).catch(() => null);
  if (!bridge) return TUI_NOT_TTY;
  const session = bridge; // non-null alias so the closures below don't see `| null`
  session.setPermMode(startMode);

  // ── raw mode setup + restore ─────────────────────────────────────────────── //
  function restore(): void {
    if (!entered) return;
    entered = false;
    try {
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      stdout.write(RESTORE_TUI);
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
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
  // A crash (uncaughtException / unhandledRejection) must not merely restore the
  // terminal and return — that leaves the exit promise UNRESOLVED and the host hung.
  // finish(1) restores AND resolves with a non-zero code so the caller exits cleanly.
  function onCrash(): void {
    finish(1);
  }
  function finish(code: number): void {
    if (resolveExit === null) return;
    renderer.clear();
    restore();
    stdout.write("\n");
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
      if (modalLines > 1) safeWrite(`\r\x1b[${modalLines - 1}A`);
      else safeWrite("\r");
      safeWrite("\x1b[0J"); // erase cursor→end-of-screen (removes wrapped remnants)
      safeWrite(lines.join("\r\n"));
      modalLines = lines.length;
      // CLI-065/066: reposition the cursor to the caret column on the PROMPT line (row 0) — works
      // with an optional hint row (CLI-066) below the prompt. Only when the prompt itself fits one
      // line (the common case; a wrapped prompt leaves the cursor at the end).
      const promptRows = lines.length - (modal.hint ? 1 : 0);
      if (promptRows === 1) {
        if (lines.length > 1) safeWrite(`\x1b[${lines.length - 1}A`); // back up to the prompt row
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
    const ctx: ReduceCtx = { items: AC_ITEMS, running };
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
      }
    }
  }

  async function handleSubmit(text: string): Promise<void> {
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
    }
    // close an unterminated fence at turn end so the box always finishes.
    const tail = md.flush();
    if (tail.length > 0) renderer.printAbove(tail.join("\n"));
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
          modal = { ...applyModalKey(modal, k), hint: "" };
          paintModal();
        }
      };
      modal = { kind: "ask", prompt: `${prompt} (default ${def})`, buffer: "", caret: 0 };
      modalLines = 0;
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
    stdin.on("data", onData);
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
