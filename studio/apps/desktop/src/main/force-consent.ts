// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/force-consent.ts — a FORCE flag from the renderer is a request, never a consent.
 *
 * Several channels take `force` / `forced` / `confirmForce` and pass it to the engine as
 * `--force`: install code nemesis BLOCKED, clone a repo it refused, pull a model it flagged.
 * The renderer shows its own "are you sure" sheet first — but that sheet is UX. A compromised
 * renderer (the process every guard here exists to survive, C5) sets the boolean itself and the
 * engine overrides the gate with no human ever having seen it.
 *
 * So MAIN asks, natively, whenever a call carries a force flag. Declined → the flags are
 * cleared and the call proceeds UNFORCED (the gate's refusal stands). Electron is imported
 * lazily so a test whose electron mock has no `dialog` fails CLOSED (no consent) instead of
 * failing to load.
 */

type Ask = (sender: unknown, message: string, detail: string) => Promise<boolean>;

let testAsk: Ask | null = null;

/** Test seam: answer the native prompt (null restores the real dialog). */
export function setForceConsentForTests(ask: Ask | null): void {
  testAsk = ask;
}

const FORCE_KEYS = ["force", "forced", "confirmForce"] as const;

function targetOf(o: Record<string, unknown>): string {
  for (const k of ["id", "name", "spec", "url", "source", "repo", "model", "path", "package"]) {
    const v = o[k];
    if (typeof v === "string" && v) return `${k}: ${v.slice(0, 300)}`;
  }
  return "(no target named)";
}

async function nativeAsk(
  sender: unknown,
  message: string,
  detail: string,
  okLabel = "Override",
): Promise<boolean> {
  try {
    const electron = (await import("electron")) as unknown as {
      dialog?: {
        showMessageBox: (a: unknown, b?: unknown) => Promise<{ response: number }>;
      };
      BrowserWindow?: { fromWebContents?: (wc: unknown) => unknown };
    };
    const dialog = electron.dialog;
    if (!dialog) return false;
    const win = sender ? (electron.BrowserWindow?.fromWebContents?.(sender) ?? null) : null;
    const opts = {
      type: "warning",
      buttons: ["Cancel", okLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message,
      detail,
    };
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 1;
  } catch {
    return false;
  }
}

/**
 * Returns `arg` unchanged when it carries no force flag or the human approved; otherwise a copy
 * with every force flag set to false. `event` is the IPC event (its `sender` parents the dialog).
 */
export async function consentToForce(
  event: unknown,
  channel: string,
  arg: unknown,
): Promise<unknown> {
  if (!arg || typeof arg !== "object" || Array.isArray(arg)) return arg;
  const o = arg as Record<string, unknown>;
  if (!FORCE_KEYS.some((k) => o[k] === true)) return arg;
  const sender = (event as { sender?: unknown } | null)?.sender;
  const message = "Override a safety refusal?";
  const detail = `The app asked to FORCE "${channel}" — ${targetOf(o)}.\n\nForcing installs or runs something the nemesis gate refused or flagged. Only continue if you asked for this and accept the risk.`;
  const ok = await (testAsk ?? nativeAsk)(sender, message, detail);
  if (ok) return arg;
  const out: Record<string, unknown> = { ...o };
  for (const k of FORCE_KEYS) if (k in out) out[k] = false;
  return out;
}

/** The control / bidi characters a finding must not smuggle into the dialog unseen. */
const INVISIBLE =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A nemesis WARN is accepted only by the human, in a MAIN-process dialog that shows the findings
 * main itself received from the gate. The renderer used to be able to accept any WARN main had
 * reported in the last ten minutes by sending `acceptWarn: true` — no person involved.
 */
export async function consentToWarn(
  event: unknown,
  target: string,
  reasons: readonly string[],
): Promise<boolean> {
  const sender = (event as { sender?: unknown } | null)?.sender;
  const shown = reasons.slice(0, 12).map((r) => `• ${r.replace(INVISIBLE, "?").slice(0, 300)}`);
  const more = reasons.length > shown.length ? `\n…and ${reasons.length - shown.length} more` : "";
  const detail = `nemesis flagged ${target.replace(INVISIBLE, "?").slice(0, 300)}:\n\n${
    shown.join("\n") || "• (no details were reported)"
  }${more}\n\nUse it anyway only if you trust its source.`;
  return (testAsk ?? nativeAsk)(
    sender,
    "Use a model nemesis warned about?",
    detail,
    "Use it anyway",
  );
}
