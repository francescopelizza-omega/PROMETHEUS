// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * system-probe.ts — read-only host-tool probes, centralized in engine-bridge (C5).
 *
 * The desktop telemetry (CPU/GPU/NPU/RAM) needs a few native tools that have no
 * node:os equivalent — `vm_stat` (macOS available memory), `nvidia-smi` (GPU
 * VRAM/util), `system_profiler` (Apple GPU name). Per the SPINE rule, child_process
 * lives ONLY here; the main process calls `probeSystemCommand` instead of spawning
 * itself. This is a READ-ONLY capture (no shell, sanitized env, hard timeout,
 * bounded buffer) — never a general shell-out.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { safeChildEnv } from "./safe-env.js";

const execFileP = promisify(execFile);

export interface ExecCaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a host tool shell-free and capture (code, stdout, stderr), optionally piping a
 * value via stdin. Unlike `probeSystemCommand` this returns the EXIT CODE (callers that
 * treat a specific non-zero code as "not found" need it) and supports stdin (so a secret
 * never lands on argv). Sanitized env, no shell. Never throws — a spawn error → code 127.
 * Centralized here because engine-bridge is the SOLE child_process owner (C5 / SPINE).
 */
export function execCapture(
  command: string,
  args: string[] = [],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<ExecCaptureResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: safeChildEnv(),
      timeout: opts.timeoutMs ?? 10_000,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("error", () => resolve({ code: 127, stdout, stderr: stderr || "spawn failed" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}

export interface ProbeOptions {
  /** hard timeout in ms (default 4000). */
  timeoutMs?: number;
  /** max captured stdout bytes (default 4 MiB). */
  maxBuffer?: number;
}

/**
 * Run a read-only host tool and return its stdout, or `null` on ANY failure
 * (missing binary, non-zero exit, timeout). Never throws, never uses a shell — the
 * command + args are passed to execFile verbatim (no interpolation), and the env is
 * sanitized (safeChildEnv strips the LD_PRELOAD / DYLD injection seams).
 */
export async function probeSystemCommand(
  command: string,
  args: string[] = [],
  opts: ProbeOptions = {},
): Promise<string | null> {
  try {
    const { stdout } = await execFileP(command, args, {
      timeout: opts.timeoutMs ?? 4000,
      env: safeChildEnv(),
      windowsHide: true,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}
