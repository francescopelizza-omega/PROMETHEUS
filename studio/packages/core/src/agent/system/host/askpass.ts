// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/host/askpass.ts — the graphical password helper for `sudo -A`.
 *
 * A GUI surface (Studio, VS Code) has no terminal for sudo to read a password from, so the
 * privileged gate runs `sudo -A` with `SUDO_ASKPASS` pointing at a tiny helper. sudo runs the
 * helper, the helper shows a native dialog, and the typed password goes from the helper's
 * stdout STRAIGHT to sudo. Prometheus never sees it: it is not in an IPC payload, a log, a
 * transcript or the model's context, because no Prometheus process ever reads it.
 *
 * The helper is FIXED TEXT. sudo passes its prompt as `$1`, and the script only quotes that —
 * nothing from the request, the model or the environment is interpolated into the file. The
 * dialog binary is resolved from fixed system paths and must be root-owned (`trustedBinary`):
 * a `zenity` planted earlier on PATH would otherwise receive the password.
 *
 * Written once per process into a private `mkdtemp` directory (0700), file 0700.
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustedBinary } from "./privileged-gate.js";

export type AskpassHelper =
  | { kind: "osascript"; path: string }
  | { kind: "zenity"; path: string }
  | { kind: "kdialog"; path: string }
  | { kind: "ssh-askpass"; path: string };

const TITLE = "Prometheus — administrator password";

/** The helper script. Pure, so the exact text is pinned by a test. */
export function askpassScript(h: AskpassHelper): string {
  const header =
    "#!/bin/sh\n# Prometheus askpass helper: sudo runs this and reads the password from its stdout.\n# The prompt arrives as $1; nothing else is interpolated into this file.\n";
  switch (h.kind) {
    case "osascript":
      return `${header}exec ${h.path} -e 'on run argv' -e 'display dialog (item 1 of argv) with title "${TITLE}" default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" with icon caution' -e 'return text returned of result' -e 'end run' "$1"\n`;
    case "zenity":
      return `${header}exec ${h.path} --entry --hide-text --title="${TITLE}" --text="$1"\n`;
    case "kdialog":
      return `${header}exec ${h.path} --title "${TITLE}" --password "$1"\n`;
    case "ssh-askpass":
      return `${header}exec ${h.path} "$1"\n`;
  }
}

const LINUX_HELPERS: readonly AskpassHelper[] = [
  { kind: "zenity", path: "/usr/bin/zenity" },
  { kind: "kdialog", path: "/usr/bin/kdialog" },
  { kind: "ssh-askpass", path: "/usr/bin/ssh-askpass" },
  { kind: "ssh-askpass", path: "/usr/lib/ssh/ssh-askpass" },
  { kind: "ssh-askpass", path: "/usr/libexec/openssh/ssh-askpass" },
];

let cached: string | null = null;

/**
 * Write the helper for this machine and return its path, or null when there is no graphical
 * helper (Linux with no display, or no dialog program installed) — the gate then refuses and
 * says to use a terminal; it never falls back to anything that could read the password itself.
 */
export async function prepareAskpass(
  opts: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    trusted?: (path: string) => boolean;
    /** test seam: ignore the per-process cache */
    fresh?: boolean;
  } = {},
): Promise<string | null> {
  // re-checked, not trusted: the OS purges temp dirs (macOS after days without access)
  if (cached && !opts.fresh && existsSync(cached)) return cached;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const trusted = opts.trusted ?? trustedBinary;

  let helper: AskpassHelper | undefined;
  if (platform === "darwin") {
    const h: AskpassHelper = { kind: "osascript", path: "/usr/bin/osascript" };
    if (trusted(h.path)) helper = h;
  } else if (platform === "linux") {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    helper = LINUX_HELPERS.find((h) => trusted(h.path));
  }
  if (!helper) return null;

  const dir = mkdtempSync(join(tmpdir(), "prom-askpass-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "askpass.sh");
  writeFileSync(file, askpassScript(helper), { mode: 0o700 });
  chmodSync(file, 0o700);
  cached = file;
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return file;
}
