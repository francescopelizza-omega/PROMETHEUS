/**
 * tui/keys.ts — a ZERO-dependency raw-mode key decoder.
 *
 * Raw stdin delivers bytes, not keystrokes: arrows arrive as CSI escape sequences,
 * a paste as a bracketed `ESC[200~ … ESC[201~` block, and a fast typist's chunk may
 * carry several keys at once OR split one escape sequence across two reads. This
 * module turns a raw string chunk into a list of semantic `KeyEvent`s, returning any
 * trailing INCOMPLETE escape sequence as `rest` so the reader can prepend it to the
 * next chunk (no lost arrows, no split-CSI corruption).
 *
 * PURE: no IO, no state. The app owns the rolling buffer + the lone-ESC flush timer.
 */

/** The semantic key names the composer reducer understands. */
export type KeyName =
  | "enter"
  | "newline"
  | "tab"
  | "backtab"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "word-left"
  | "word-right"
  // Cmd/Meta motions: ⌘←/→ jump to line start/end; ⌘↑/↓ jump WHOLE history entries.
  | "line-home"
  | "line-end"
  | "history-entry-prev"
  | "history-entry-next"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-l"
  | "ctrl-u"
  | "ctrl-k"
  | "ctrl-a"
  | "ctrl-e"
  | "ctrl-w"
  | "ctrl-r"
  | "ctrl-t"
  | "ctrl-g"
  | "ctrl-s"
  | "ctrl-y"
  | "esc"
  | "char"
  | "paste"
  | "mouse";

/** A decoded SGR mouse report (CLI-069). Coords are 1-based cells. */
export interface MouseInfo {
  /** low 2 bits of Cb: 0=left, 1=middle, 2=right. */
  button: number;
  /** 1-based column. */
  x: number;
  /** 1-based row. */
  y: number;
  /** `M` = press, `m` = release. */
  pressed: boolean;
  /** set for a wheel event (Cb bit 64); direction from Cb bit 0. */
  wheel?: "up" | "down";
}

/** One decoded key. `ch` carries the text for `char`/`paste`; `mouse` for a `mouse` event. */
export interface KeyEvent {
  name: KeyName;
  ch?: string;
  mouse?: MouseInfo;
}

const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Single control bytes → a key name (the ones we act on; others are ignored). */
const CTRL: Record<string, KeyName> = {
  // raw mode: Enter sends CR (0x0D); LF (0x0A = Ctrl-J) is the GUARANTEED newline
  // (most terminals can't distinguish Shift+Enter from Enter without the Kitty protocol).
  "\r": "enter",
  "\n": "newline",
  "\t": "tab",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x03": "ctrl-c",
  "\x04": "ctrl-d",
  "\x0c": "ctrl-l",
  "\x15": "ctrl-u",
  "\x0b": "ctrl-k",
  "\x01": "ctrl-a",
  "\x05": "ctrl-e",
  "\x17": "ctrl-w",
  // Ctrl-R (\x12) is a plan-§7 DEVIATION: reserved for reverse-i-search history (CLI-019/062
  // lineage), NOT §7's original assignment. Documented here per CLI-067.
  "\x12": "ctrl-r",
  "\x14": "ctrl-t", // DC4 — quick-toggle all agent tools (CLI-018)
  "\x07": "ctrl-g", // BEL — cycle the focused pane (plan §7, CLI-067). Harmless as input.
  "\x19": "ctrl-y", // EM — copy the last assistant reply via OSC 52 (CLI-068).
  // Ctrl-S (\x13 = XOFF) reaches us ONLY because raw mode disables terminal flow control (IXON);
  // the readline/tmux (--plain) hosts run cooked and NEVER see it — Ctrl+S is raw-mode-only (CLI-067).
  "\x13": "ctrl-s", // save the transcript (plan §7, CLI-067)
};

/** A final CSI/SS3 byte → key name, for `ESC[<final>` and `ESC O <final>`. */
const CSI_FINAL: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "backtab",
};

/** A CSI `ESC[<n>~` numeric key → key name. */
const CSI_TILDE: Record<string, KeyName> = {
  "1": "home",
  "7": "home",
  "4": "end",
  "8": "end",
  "3": "delete",
  "5": "pageup",
  "6": "pagedown",
};

/** Is `s` a strict prefix of a longer sequence we'd recognize once more bytes arrive? */
function isIncompletePrefix(s: string): boolean {
  if (s === ESC) return true; // bare ESC at end — could be a CSI/SS3 start
  if (s === `${ESC}[` || s === `${ESC}O`) return true;
  if (s.startsWith(`${ESC}[`)) {
    // a CSI in progress: digits/semicolons not yet closed by a final byte, OR a
    // partial bracketed-paste introducer (ESC[200~ / ESC[201~).
    const body = s.slice(2);
    if (/^[0-9;]*$/.test(body)) return true;
    if (PASTE_START.startsWith(s) || PASTE_END.startsWith(s)) return true;
    // a partial SGR mouse report `ESC[<Cb;Cx;Cy` not yet closed by M/m (CLI-069, split reads).
    if (/^<[0-9;]*$/.test(body)) return true;
  }
  return false;
}

/**
 * Decode a raw chunk into key events. Returns the events plus any trailing
 * INCOMPLETE escape sequence in `rest` (prepend it to the next chunk). A bracketed
 * paste collapses to ONE `paste` event so it can't be mistaken for typed commands.
 */
export function decodeKeys(buf: string): { events: KeyEvent[]; rest: string } {
  const events: KeyEvent[] = [];
  let i = 0;
  while (i < buf.length) {
    const ch = buf[i] as string;

    // — non-escape: a control byte or a printable code point —
    if (ch !== ESC) {
      const ctrl = CTRL[ch];
      if (ctrl) {
        events.push({ name: ctrl });
        i += 1;
        continue;
      }
      const code = buf.codePointAt(i);
      if (code !== undefined && code < 0x20) {
        // an unmapped control byte → ignore (e.g. NUL, other Ctrl combos)
        i += 1;
        continue;
      }
      const cp = String.fromCodePoint(code ?? ch.charCodeAt(0));
      events.push({ name: "char", ch: cp });
      i += cp.length;
      continue;
    }

    // — escape sequences —
    const tail = buf.slice(i);

    // bracketed paste: collapse ESC[200~ … ESC[201~ into one paste event.
    if (tail.startsWith(PASTE_START)) {
      const endRel = tail.indexOf(PASTE_END, PASTE_START.length);
      if (endRel === -1) return { events, rest: tail }; // paste not fully arrived yet
      const inner = tail.slice(PASTE_START.length, endRel);
      events.push({ name: "paste", ch: inner });
      i += endRel + PASTE_END.length;
      continue;
    }

    // alt/shift-enter → a literal newline (multi-line composer).
    if (tail.startsWith(`${ESC}\r`) || tail.startsWith(`${ESC}\n`)) {
      events.push({ name: "newline" });
      i += 2;
      continue;
    }

    // SGR mouse report (CLI-069): ESC [ < Cb ; Cx ; Cy (M=press | m=release). Must be tried BEFORE
    // the generic CSI branch (whose param class `[0-9;]*` excludes the leading `<`).
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(tail);
    if (mouse) {
      const cb = Number(mouse[1]);
      const info: MouseInfo = {
        button: cb & 3,
        x: Number(mouse[2]),
        y: Number(mouse[3]),
        pressed: mouse[4] === "M",
      };
      if ((cb & 64) !== 0) info.wheel = (cb & 1) === 1 ? "down" : "up"; // bit 64 = wheel
      events.push({ name: "mouse", mouse: info });
      i += (mouse[0] as string).length;
      continue;
    }

    // CSI: ESC [ … final   /   SS3: ESC O final
    const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(tail);
    const ss3 = /^\x1bO([A-Za-z])/.exec(tail);
    if (csi) {
      const [, params, final] = csi as unknown as [string, string, string];
      // Modifier param (xterm/CSI-u): `ESC[1;<m><final>`. m = 1 + bitmask(Shift1 Alt2 Ctrl4 Meta8).
      const mod = Math.max(0, (Number.parseInt(params.split(";")[1] ?? "1", 10) || 1) - 1);
      const meta = (mod & 8) !== 0; // ⌘ / Meta
      const altOrCtrl = (mod & (2 | 4)) !== 0; // ⌥ Option or Ctrl
      if (final === "C" || final === "D") {
        // ←/→ : ⌘ → line home/end · ⌥/Ctrl → word · none → char step.
        if (meta) events.push({ name: final === "C" ? "line-end" : "line-home" });
        else if (altOrCtrl) events.push({ name: final === "C" ? "word-right" : "word-left" });
        else events.push({ name: final === "C" ? "right" : "left" });
      } else if (final === "A" || final === "B") {
        // ↑/↓ : ⌘ → jump WHOLE history entries (ignore the multi-line cursor); else vertical move.
        if (meta) {
          events.push({ name: final === "A" ? "history-entry-prev" : "history-entry-next" });
        } else {
          events.push({ name: final === "A" ? "up" : "down" });
        }
      } else {
        const name = final === "~" ? CSI_TILDE[params.split(";")[0] ?? ""] : CSI_FINAL[final];
        if (name) events.push({ name });
      }
      i += (csi[0] as string).length;
      continue;
    }
    if (ss3) {
      const name = CSI_FINAL[ss3[1] as string];
      if (name) events.push({ name });
      i += (ss3[0] as string).length;
      continue;
    }
    // Option-as-Meta (Terminal.app "Use Option as Meta key"): ESC-b / ESC-f = word motion,
    // the readline M-b / M-f convention — so ⌥←/→ still jumps words in that terminal mode.
    const metaWord = /^\x1b([bf])/.exec(tail);
    if (metaWord) {
      events.push({ name: metaWord[1] === "f" ? "word-right" : "word-left" });
      i += 2;
      continue;
    }

    // an incomplete trailing sequence → hand back as `rest` for the next read.
    if (isIncompletePrefix(tail)) return { events, rest: tail };

    // a bare ESC that is NOT the start of a recognized sequence → the Esc key.
    events.push({ name: "esc" });
    i += 1;
  }
  return { events, rest: "" };
}

/* ==========================================================================
 * Keymap layer (CLI-096) — a PURE key→action resolution ON TOP of the decoder.
 *
 * The decoder stays byte-level and config-free (its contract). This layer maps a
 * user `[keymap]` TOML table onto the reducer's ACTIONS, detects conflicts + reserved-
 * key violations at load, and exposes `remapKey` so the reducer translates a physical
 * key into the action's canonical default key without a giant switch rewrite. Reuses
 * the settings/keymap conflict shape (Map<key, action[]>), not a fourth format.
 * ======================================================================== */

/** A rebindable reducer action (excludes the RESERVED cancel/dismiss — see below). */
export type Action =
  | "send"
  | "newline"
  | "mode-cycle"
  | "history-prev"
  | "history-next"
  | "autocomplete"
  | "clear-line"
  | "clear-to-eol"
  | "delete-word"
  | "line-start"
  | "line-end"
  | "search"
  | "redraw"
  | "toggle-tools"
  | "cycle-pane"
  | "save-transcript"
  | "copy-reply";

/** Action → its DEFAULT physical key (the KeyName the reducer switch already matches). */
export const DEFAULT_BINDINGS: Record<Action, KeyName> = {
  send: "enter",
  newline: "newline",
  "mode-cycle": "backtab",
  "history-prev": "up",
  "history-next": "down",
  autocomplete: "tab",
  "clear-line": "ctrl-u",
  "clear-to-eol": "ctrl-k",
  "delete-word": "ctrl-w",
  "line-start": "ctrl-a",
  "line-end": "ctrl-e",
  search: "ctrl-r",
  redraw: "ctrl-l",
  // ⌃T now OPENS the trait rail focused on the `tool` cell rather than flipping tools blind
  // (reducer.ts's `ctrl-t` case). The action keeps its name so existing `[keymap]` tables that
  // rebound `toggle-tools` keep working — it is still the key that reaches the tools switch.
  "toggle-tools": "ctrl-t",
  "cycle-pane": "ctrl-g",
  "save-transcript": "ctrl-s",
  "copy-reply": "ctrl-y",
};

/** Keys that can NEVER be a rebind target (deliverable 3): cancel + dismiss are load-bearing. Note
 *  ctrl-c in raw mode is a reducer action, NOT an OS SIGINT — rebinding away wouldn't restore it. */
export const RESERVED_KEYS: ReadonlySet<KeyName> = new Set<KeyName>(["ctrl-c", "esc"]);

/** Reserved action NAMES a user might try to move — attempting to is a NAMED error, not a skip. */
const RESERVED_ACTIONS: ReadonlySet<string> = new Set(["cancel", "dismiss", "paste"]);

/** Terminal control-key aliases collapse to one byte — binding one silently binds its twin. */
const KEY_ALIASES: Record<string, KeyName> = {
  "ctrl-i": "tab", // Ctrl+I == Tab (0x09)
  "ctrl-m": "enter", // Ctrl+M == Enter (0x0D)
  "ctrl-h": "backspace", // Ctrl+H == Backspace (0x08)
  "ctrl-[": "esc", // Ctrl+[ == Esc (0x1B)
};

/** The set of key tokens a user may bind TO (the decoder's names minus non-physical char/paste/mouse). */
const BINDABLE_KEYS: ReadonlySet<string> = new Set<string>(
  Object.values(DEFAULT_BINDINGS).concat([
    "esc",
    "ctrl-c",
    "ctrl-d",
    "backspace",
    "delete",
    "left",
    "right",
    "home",
    "end",
    "pageup",
    "pagedown",
    "word-left",
    "word-right",
  ]),
);

/** The resolved keymap: the effective bindings + provenance + any load-time diagnostics. */
export interface KeymapResolution {
  /** true unless a fatal conflict / reserved violation forced a fallback to DEFAULT_BINDINGS. */
  ok: boolean;
  bindings: Record<Action, KeyName>;
  sources: Record<Action, "default" | "user">;
  /** physical key → action, for the reducer's `remapKey`. */
  reverse: Partial<Record<KeyName, Action>>;
  /** fatal diagnostics (conflict / reserved) — present ⇒ ok:false ⇒ defaults in effect. */
  errors: string[];
  /** non-fatal skipped entries (unknown action/key) — the default is kept for that action. */
  warnings: string[];
}

function isAction(x: string): x is Action {
  return Object.hasOwn(DEFAULT_BINDINGS, x);
}

function buildReverse(bindings: Record<Action, KeyName>): Partial<Record<KeyName, Action>> {
  const rev: Partial<Record<KeyName, Action>> = {};
  for (const [action, key] of Object.entries(bindings) as [Action, KeyName][]) rev[key] = action;
  return rev;
}

const defaultsResolution = (): KeymapResolution => ({
  ok: true,
  bindings: { ...DEFAULT_BINDINGS },
  sources: Object.fromEntries(Object.keys(DEFAULT_BINDINGS).map((a) => [a, "default"])) as Record<
    Action,
    "default" | "user"
  >,
  reverse: buildReverse(DEFAULT_BINDINGS),
  errors: [],
  warnings: [],
});

/**
 * Resolve the effective keymap from a raw `[keymap]` table (CLI-096). Merges user bindings over the
 * defaults, then: (a) reserved action/key violations → NAMED error, (b) unknown action/key → skip +
 * warning (keep the default), (c) a key bound to 2+ actions → NAMED conflict error. ANY error ⇒ the
 * whole config is refused and DEFAULT_BINDINGS are returned with `ok:false` (the caller warns loudly,
 * never a silent partial load). Pure.
 */
export function resolveKeymap(raw: Record<string, unknown> | undefined): KeymapResolution {
  if (!raw || typeof raw !== "object") return defaultsResolution();
  const bindings: Record<Action, KeyName> = { ...DEFAULT_BINDINGS };
  const sources: Record<Action, "default" | "user"> = Object.fromEntries(
    Object.keys(DEFAULT_BINDINGS).map((a) => [a, "default"]),
  ) as Record<Action, "default" | "user">;
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [rawAction, rawKey] of Object.entries(raw)) {
    const action = rawAction.trim();
    if (RESERVED_ACTIONS.has(action)) {
      errors.push(`cannot rebind reserved action '${action}' (it is not user-configurable)`);
      continue;
    }
    if (!isAction(action)) {
      warnings.push(`unknown action '${action}' — skipped (kept the defaults)`);
      continue;
    }
    const token = typeof rawKey === "string" ? rawKey.trim().toLowerCase() : "";
    const key = (KEY_ALIASES[token] ?? token) as KeyName;
    if (KEY_ALIASES[token]) {
      warnings.push(
        `'${token}' is an alias of '${key}' (same byte) — bound '${action}' to '${key}'`,
      );
    }
    if (!token || !BINDABLE_KEYS.has(key)) {
      warnings.push(`unknown key '${rawKey}' for action '${action}' — skipped (kept the default)`);
      continue;
    }
    if (RESERVED_KEYS.has(key)) {
      errors.push(`cannot bind action '${action}' to reserved key '${key}'`);
      continue;
    }
    bindings[action] = key;
    sources[action] = "user";
  }

  // conflict pass: a key bound to 2+ actions is a fatal, NAMED conflict.
  const byKey = new Map<KeyName, Action[]>();
  for (const [action, key] of Object.entries(bindings) as [Action, KeyName][]) {
    const list = byKey.get(key) ?? [];
    list.push(action);
    byKey.set(key, list);
  }
  for (const [key, actions] of byKey) {
    if (actions.length > 1) {
      errors.push(`key '${key}' bound to multiple actions: ${actions.sort().join(", ")}`);
    }
  }

  if (errors.length > 0) {
    // refuse the whole config: fall back to defaults, but SURFACE the errors (never silent).
    return { ...defaultsResolution(), ok: false, errors, warnings };
  }
  return { ok: true, bindings, sources, reverse: buildReverse(bindings), errors, warnings };
}

/**
 * Translate a PHYSICAL decoded key into the canonical default key of the action it's bound to, so
 * the reducer's existing switch runs that action (CLI-096). Identity when the key isn't bound to a
 * rebindable action (its own default behavior is preserved). Pure.
 */
export function remapKey(res: KeymapResolution, physical: KeyName): KeyName {
  const action = res.reverse[physical];
  return action ? DEFAULT_BINDINGS[action] : physical;
}

/**
 * Render the effective keymap for `/keys` (CLI-096): one line per action (key · action · source),
 * user overrides marked with `*`, then the reserved (unbindable) keys. Plain strings — the caller
 * tints. On a refused config (`ok:false`) the error lines lead so the fallback is obvious.
 */
export function renderKeymap(res: KeymapResolution): string[] {
  const lines: string[] = [];
  if (!res.ok) {
    lines.push("keymap config REFUSED — using defaults:");
    for (const e of res.errors) lines.push(`  ✗ ${e}`);
  }
  for (const w of res.warnings) lines.push(`  ! ${w}`);
  const actions = Object.keys(DEFAULT_BINDINGS) as Action[];
  const keyW = Math.max(...actions.map((a) => res.bindings[a].length));
  for (const a of actions) {
    const key = res.bindings[a].padEnd(keyW);
    const src = res.sources[a] === "user" ? "user *" : "default";
    lines.push(`  ${key}  ${a}  (${src})`);
  }
  lines.push(`  reserved (unbindable): ${[...RESERVED_KEYS].join(", ")}`);
  return lines;
}
