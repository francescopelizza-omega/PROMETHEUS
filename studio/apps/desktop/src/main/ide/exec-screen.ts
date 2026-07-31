/**
 * main/ide/exec-screen.ts — a fail-closed destructive-command screen for `ide:exec`.
 *
 * The agentic tool-loop can propose a shell command; the user must APPROVE it (the §7.3
 * task card), and even then this conservative blocklist BLOCKS obviously catastrophic
 * commands outright — defense in depth on top of the mandatory human approval + the
 * hardened spawn env (safeChildEnv). This is a GUARD, not a guarantee: it cannot
 * enumerate every dangerous command, it stops the worst footguns a hallucinated or
 * prompt-injected model might emit. Mirrors the engine's "defense-in-depth, not a
 * guarantee" posture. PURE — node:test-able, no electron / child_process.
 */

/** The screen verdict for one command. */
export interface CommandScreen {
  blocked: boolean;
  reason?: string;
}

/** Patterns that are blocked regardless of approval (catastrophic / privilege / RCE). */
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
 * Screen a proposed command. Returns `{blocked:true, reason}` for empty / oversized /
 * catastrophic commands, else `{blocked:false}`. Charset (control chars) is enforced by
 * the zod validator at the IPC boundary; this layer is the dangerous-pattern guard.
 */
export function screenCommand(command: string): CommandScreen {
  const cmd = (command ?? "").trim();
  if (!cmd) return { blocked: true, reason: "empty command" };
  if (cmd.length > 8192) return { blocked: true, reason: "command too long" };
  for (const d of DANGEROUS) {
    if (d.re.test(cmd)) return { blocked: true, reason: d.reason };
  }
  return { blocked: false };
}
