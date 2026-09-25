/**
 * session/exec-jobs.ts — background jobs for `run_command` (full_wrapper_compose Phase 4 / §9).
 *
 * `collect` mode is fine for `git status`. It is the wrong shape for `pip install`, which can
 * run for minutes: a tool that blocks the turn for four minutes and then returns 16KB is both
 * a bad experience and a way to hit the turn timeout on work that was succeeding.
 *
 * So a command can be BACKGROUNDED. `run_command` returns a handle immediately; the agent
 * polls `job_status`, reads `job_output`, and can `job_kill`. Three properties matter:
 *
 *  1. **A background job is still gated.** It goes through the identical parse → classify →
 *     nemesis → ladder path first. Backgrounding changes when you get the output, never
 *     whether the command was allowed.
 *  2. **Every job is orphan-guard registered**, so a Ctrl-C — or a SIGKILL of the CLI itself —
 *     still reaps it. A background job is exactly the process most likely to outlive its
 *     parent, which is why the acceptance criterion for this phase is about `pip install`.
 *  3. **Bounded.** A ring-buffered output cap and a hard wall-clock, because a background job
 *     nobody polls is otherwise a leak with a friendly name.
 */

import type { ExecTier } from "../../exec/index.js";

import {
  type ExecPipelineResult,
  MAX_BACKGROUND_TIMEOUT_MS,
  type RunPipelineOptions,
} from "./exec-runner.js";

/** A job's lifecycle. `killed` is distinct from `failed` — the human ended it deliberately. */
export type JobState = "running" | "done" | "failed" | "killed" | "timeout";

export interface JobRecord {
  id: string;
  command: string;
  tier: ExecTier;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  /** captured output, ring-capped (see MAX_JOB_OUTPUT). */
  output: string;
  truncated: boolean;
  /** set for `state: "failed"` when the failure was ours, not the command's. */
  error?: string;
}

/** How much of a background job's output is retained. Older bytes are dropped from the FRONT —
 *  the tail of a build log is where the error is. */
const MAX_JOB_OUTPUT = 64 * 1024;
/** How many finished jobs are kept for polling before the oldest is forgotten. */
const MAX_FINISHED = 20;
/**
 * A background job's own watchdog: a backstop, never the limit a caller actually hits.
 *
 * It was 30 min while `execTimeoutMs` grants a background call up to MAX_BACKGROUND_TIMEOUT_MS
 * (6 h), so every job asked to run longer than 30 min was aborted at 30 min. It also came
 * through the signal, not the runner's own timer, so the job reported "killed" (the state for a
 * deliberate job_kill) instead of "timeout". Now it is the same 6 h ceiling plus a minute of
 * grace. The runner's own timer is per PIPELINE, so a multi-part `a && b` job can still
 * outlive this watchdog without either part timing out — which is why startJob records that
 * the watchdog fired, and reports "timeout" for it, rather than trusting timer order.
 */
export const MAX_BACKGROUND_MS = MAX_BACKGROUND_TIMEOUT_MS + 60_000;

const jobs = new Map<string, JobRecord>();
const cancels = new Map<string, () => void>();
let seq = 0;

/** Mint a short, readable handle. Sequential rather than random so a log reads in order. */
function mintId(): string {
  seq += 1;
  return `job-${seq}`;
}

/** Append to a job's ring buffer, dropping from the FRONT when it overflows. */
function appendOutput(job: JobRecord, chunk: string): void {
  const next = job.output + chunk;
  if (next.length <= MAX_JOB_OUTPUT) {
    job.output = next;
    return;
  }
  job.output = next.slice(next.length - MAX_JOB_OUTPUT);
  job.truncated = true;
}

/** Forget the oldest finished jobs so a long session does not accumulate them forever. */
function prune(): void {
  const finished = [...jobs.values()]
    .filter((j) => j.state !== "running")
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  while (finished.length > MAX_FINISHED) {
    const oldest = finished.shift();
    if (oldest) jobs.delete(oldest.id);
  }
}

export interface StartJobArgs {
  command: string;
  tier: ExecTier;
  /** the already-parsed, already-gated pipeline runner — jobs never re-decide policy. */
  run: (opts: {
    onOutput: (chunk: string) => void;
    signal: AbortSignal;
  }) => Promise<ExecPipelineResult>;
  timeoutMs?: number;
}

/**
 * Start a job and return its handle immediately.
 *
 * The caller has ALREADY parsed, classified, scanned and had the command approved — `run` is
 * a closure over that decision. Nothing in this module inspects a command line, which is the
 * point: there is exactly one place where a command is judged, and it is not here.
 */
export function startJob(args: StartJobArgs): JobRecord {
  const id = mintId();
  const job: JobRecord = {
    id,
    command: args.command,
    tier: args.tier,
    state: "running",
    startedAt: Date.now(),
    output: "",
    truncated: false,
  };
  jobs.set(id, job);

  const ac = new AbortController();
  cancels.set(id, () => ac.abort());
  // Latched, so a watchdog abort is reported as the "timeout" it is, never as "killed" (the
  // state for a deliberate job_kill), whichever timer happened to fire first.
  let expired = false;
  const deadline = setTimeout(
    () => {
      expired = true;
      ac.abort();
    },
    Math.min(args.timeoutMs ?? MAX_BACKGROUND_MS, MAX_BACKGROUND_MS),
  );
  if (typeof deadline.unref === "function") deadline.unref();

  void args
    .run({ onOutput: (c) => appendOutput(job, c), signal: ac.signal })
    .then((r) => {
      job.exitCode = r.exitCode;
      if (r.stdout) appendOutput(job, r.stdout);
      if (r.stderr) appendOutput(job, r.stderr);
      job.truncated ||= r.truncated;
      job.state =
        r.timedOut || expired
          ? "timeout"
          : ac.signal.aborted
            ? "killed"
            : r.exitCode === 0
              ? "done"
              : "failed";
    })
    .catch((e: unknown) => {
      job.state = "failed";
      job.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      job.endedAt = Date.now();
      clearTimeout(deadline);
      cancels.delete(id);
      prune();
    });

  return job;
}

/** One job by handle, or undefined when it never existed / was pruned. */
export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

/** Every job, newest first — what `job_status` with no id reports. */
export function listJobs(): JobRecord[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Ask a running job to stop. Returns false when the handle is unknown or already finished. */
export function killJob(id: string): boolean {
  const cancel = cancels.get(id);
  if (!cancel) return false;
  cancel();
  return true;
}

/** How many jobs are still running — the shell prompt / status line reads this. */
export function runningJobCount(): number {
  return [...jobs.values()].filter((j) => j.state === "running").length;
}

/** Abort every running job. Called on session teardown so nothing outlives the CLI. */
export function killAllJobs(): void {
  for (const cancel of [...cancels.values()]) cancel();
}

/** Test seam: forget every job and handle. */
export function resetJobs(): void {
  killAllJobs();
  jobs.clear();
  cancels.clear();
  seq = 0;
}

/** A one-line human summary — the shape `job_status` returns to the model. */
export function describeJob(job: JobRecord): string {
  const secs = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
  const code = job.exitCode === undefined ? "" : ` · exit ${job.exitCode}`;
  return `${job.id} [${job.state}${code} · ${secs}s · ${job.tier}] ${job.command}`;
}

/** The runner options a job needs — re-exported so callers do not import two modules. */
export type JobRunOptions = RunPipelineOptions;
