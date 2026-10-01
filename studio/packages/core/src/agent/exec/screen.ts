// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/exec/screen.ts — LAYER 6: the catastrophic-pattern denylist (§6, Phase 6).
 *
 * Promoted here from `apps/desktop/src/main/ide/exec-screen.ts`, where it was Studio's ONLY
 * defence and this file's whole reason for moving. Two things are true about it at once, and
 * both need saying:
 *
 *  1. **It is insufficient on its own.** A denylist over a command string cannot hold. This
 *     one blocks `/\bsudo\b/`; it does not block `$(echo c3Vkbw== | base64 -d)`, `${IFS}sudo`,
 *     `eval "$X"`, or a Makefile target that calls sudo. Studio relied on it plus a human
 *     click, which is why Studio was the weaker surface and why Phase 6 exists.
 *  2. **It is still worth keeping.** Layers 1–5 (parse, registry, classify, nemesis, ladder +
 *     confirm) are structural and do the real work. This one is pattern-matching, and pattern
 *     matching catches the specific catastrophes a hallucinated or injected model actually
 *     emits — `rm -rf /`, a fork bomb, `mkfs`, `dd of=/dev/disk0`. Cheap, last, and never
 *     load-bearing.
 *
 * So it runs LAST, after everything structural has already had its say, and it is documented
 * as a backstop rather than a boundary. If this layer is the only thing that stopped a
 * command, treat that as a bug report about layers 1–5.
 *
 * PURE — no node, no IO — so both hosts and the renderer can call it.
 */

/** The screen verdict for one command. */
export interface CommandScreen {
  blocked: boolean;
  reason?: string;
}

/** Longest command string the screen will consider. Beyond this, refuse rather than scan. */
export const MAX_SCREENED_LENGTH = 8192;

/** Patterns blocked regardless of approval (catastrophic / privilege / RCE). */
const DANGEROUS: { re: RegExp; reason: string }[] = [
  {
    re: /\brm\s+(?:-\S+\s+)*-\S*[rf]\S*\s+(?:-\S+\s+)*(?:\/|~|\$HOME|\*)/i,
    reason: "recursive force-delete of a root / home / glob path",
  },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { re: /\bmkfs(?:\.\w+)?\b/i, reason: "filesystem format (mkfs)" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "raw write to a device (dd of=/dev/…)" },
  { re: />\s*\/dev\/(?:sd|nvme|disk|hd|rdisk)/i, reason: "redirect to a block device" },
  { re: /\bchmod\s+(?:-\S+\s+)*-?R\S*\s+0?777\s+\//i, reason: "recursive world-writable on root" },
  {
    re: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|python3?|node|perl|ruby)\b/i,
    reason: "pipe remote content into an interpreter (remote code execution)",
  },
  { re: /(?:^|[\s;&|])sudo(?:\s|$)/i, reason: "privilege escalation (sudo)" },
  { re: /\b(?:shutdown|reboot|halt|poweroff|init\s+0)\b/i, reason: "power / shutdown command" },
  {
    re: /\b(?:diskutil|fdisk|parted|gdisk)\b[^\n]*\b(?:erase|delete|destroy|rm)\b/i,
    reason: "disk partition erase",
  },
  {
    re: /\bgit\b[^\n]*\bpush\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b|\+)/i,
    reason: "force-push / history rewrite — use the Git panel for pushes",
  },
];

/**
 * Screen a proposed command.
 *
 * Feed it the RE-RENDERED command (`formatCommand`) rather than the model's raw string
 * wherever one exists: the rendered form is what will actually run, and screening anything
 * else means screening a string that no longer describes the action.
 */
export function screenCommand(command: string): CommandScreen {
  const cmd = (command ?? "").trim();
  if (!cmd) return { blocked: true, reason: "empty command" };
  if (cmd.length > MAX_SCREENED_LENGTH) return { blocked: true, reason: "command too long" };
  for (const d of DANGEROUS) {
    if (d.re.test(cmd)) return { blocked: true, reason: d.reason };
  }
  return { blocked: false };
}
