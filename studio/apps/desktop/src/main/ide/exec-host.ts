/**
 * main/ide/exec-host.ts — the one-shot, capture-only command runner for `ide:exec`.
 *
 * Runs ONE user-approved shell command in the workspace and captures stdout/stderr/exit
 * as a value (unlike the interactive pty-host, which streams a live shell). Modeled on
 * git-host's defaultGitRunner: spawn `shell -c <command>` with shell:false (so the
 * COMMAND is one argv slot — no second-order argv injection by the host), a hardened env
 * (safeChildEnv strips linker/interpreter hijack vars), a hard timeout with SIGKILL, and
 * an output cap. Never throws for a non-zero exit (that is a RESULT the agent reads); it
 * only resolves an error envelope when the shell binary cannot launch. INJECTABLE so a
 * test can stub the runner.
 *
 * SECURITY: this layer assumes the command was already (a) screened by exec-screen and
 * (b) approved by the user. It is the execution mechanism, not the policy.
 */

import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  spawn as nodeSpawn,
} from "node:child_process";

import { safeChildEnv } from "@prometheus/engine-bridge";

/** The captured result of one command run. */
export interface ExecRunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  error?: string;
}

/** The injectable runner: run `command` in `cwd`, capture, resolve (never reject). */
export type ExecRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<ExecRunResult>;

/** Cap captured output so a runaway command can't balloon renderer memory. */
const MAX_OUTPUT = 256 * 1024;

/** The platform shell + the "run this string" flag. */
function shellInvocation(): { bin: string; flag: string } {
  if (typeof process !== "undefined" && process.platform === "win32") {
    return { bin: process.env.ComSpec || "cmd.exe", flag: "/c" };
  }
  return { bin: (typeof process !== "undefined" && process.env.SHELL) || "/bin/sh", flag: "-c" };
}

/** The default runner: spawn the platform shell with the command, capture output. */
export const defaultExecRunner: ExecRunner = (command, cwd, timeoutMs) =>
  new Promise<ExecRunResult>((resolve) => {
    const { bin, flag } = shellInvocation();
    const options: SpawnOptions = {
      cwd,
      shell: false, // the command is ONE argv slot to the shell — host adds no argv
      stdio: ["ignore", "pipe", "pipe"],
      env: safeChildEnv(),
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = nodeSpawn(bin, [flag, command], options) as ChildProcessWithoutNullStreams;
    } catch (err) {
      resolve({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cap = (acc: string, add: string): string =>
      acc.length >= MAX_OUTPUT ? acc : (acc + add).slice(0, MAX_OUTPUT);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      resolve({
        ok: false,
        exitCode: 124,
        stdout,
        stderr,
        timedOut: true,
        error: `command timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout?.on("data", (b: Buffer) => {
      stdout = cap(stdout, b.toString());
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr = cap(stderr, b.toString());
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, exitCode: 1, stdout, stderr, error: err.message });
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code ?? 1, stdout, stderr });
    });
  });
