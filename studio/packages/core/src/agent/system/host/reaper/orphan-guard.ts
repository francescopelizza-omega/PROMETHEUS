// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orphan-guard.ts — orphan protection that survives `kill -9` of the CLI.
 *
 * `child-reaper.ts` covers every path where the CLI gets to run code. The one path it
 * cannot cover is the one where it doesn't: SIGKILL, a panic, an OOM kill, a power cut.
 * That gap is what this closes, with three layers that fail independently:
 *
 *   1. REGISTRY — every tracked child is recorded to a file under $PROMETHEUS_HOME, so its
 *      existence outlives the process that spawned it. Line-oriented TSV, not JSON, because
 *      layer 2 has to read it from POSIX sh.
 *   2. SENTINEL — one tiny detached `sh` per CLI run, polling the owner pid. When the owner
 *      disappears by ANY means, it kills what the registry lists. One extra process per run,
 *      not per child: a leak fix that adds a process per agent would be self-defeating.
 *   3. STARTUP SWEEP — on launch, adopt and clean any registry whose owner is dead. Catches
 *      the case where the sentinel died too (`killall node`, a reboot mid-run).
 *
 * PID REUSE IS THE DANGEROUS PART. A recorded pid may, later, be a completely unrelated
 * process — killing it would be far worse than the leak. So a pid is only ever signalled
 * when its CURRENT command line still matches byte-for-byte what was recorded at spawn
 * time. Both the sh sentinel and the TypeScript sweeper enforce that, independently.
 *
 * Everything here is best-effort and fail-soft: guard code that can crash the CLI it is
 * meant to protect would be a bad trade. Every operation is wrapped.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One recorded child.
 *
 * `startedAt` is the pid-reuse guard; `command` is for humans reading the registry.
 *
 * It used to be the other way round, and that was a real bug with a live repro: the guard
 * compared `ps -o command=` at sweep time against the command captured at spawn time, and
 * for any program launched through a shebang or wrapper script those two strings DIFFER.
 * `python3 -c …` becomes `/opt/homebrew/…/Python -c …` once the kernel finishes the exec,
 * so a `pip install` orphan — the exact case Phase 4's acceptance criterion names — was
 * read as "this pid now belongs to someone else", skipped, and left running forever.
 *
 * A process's START TIME is fixed at fork and never changes, so it survives the exec that
 * rewrites argv. It is also what actual process supervisors use for this, for this reason.
 */
export interface ChildRecord {
  pid: number;
  /** signal the process GROUP (-pid) rather than the pid alone. */
  group: boolean;
  /** the child's command line at spawn time — DISPLAY ONLY, never the identity check. */
  command: string;
  /** `ps -o lstart=` for this pid — stable across exec, so this is the reuse guard. */
  startedAt: string;
}

/** Where registries live: one file per CLI run, named for its owner pid. */
export function registryDir(home: string): string {
  return join(home, "state", "children");
}

function registryPath(home: string, ownerPid: number): string {
  return join(registryDir(home), `${ownerPid}.tsv`);
}

/**
 * TSV, one child per line: `pid \t group \t startedAt \t command`.
 *
 * `startedAt` sits BEFORE `command` because command is the only free-form field and must
 * stay last — the shell sentinel reads these with `IFS=\t read`, which folds every trailing
 * field into the final variable. Tabs/newlines are stripped from both so a record cannot
 * split into two lines.
 */
function serialize(records: readonly ChildRecord[]): string {
  const clean = (v: string): string => v.replace(/[\t\r\n]+/g, " ");
  return records
    .map((r) => `${r.pid}\t${r.group ? 1 : 0}\t${clean(r.startedAt)}\t${clean(r.command)}`)
    .join("\n");
}

export function parseRegistry(text: string): ChildRecord[] {
  const out: ChildRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [pidStr, groupStr, startedAt, ...rest] = line.split("\t");
    const pid = Number.parseInt(pidStr ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    // A row with no start time is from an older build. It is dropped rather than trusted:
    // without the reuse guard we would be choosing between leaking an orphan and signalling
    // a stranger's pid, and only one of those is recoverable.
    if (!startedAt?.trim()) continue;
    out.push({ pid, group: groupStr === "1", startedAt, command: rest.join("\t") });
  }
  return out;
}

/**
 * Is `pid` still the process we recorded? Compares its START TIME against the recorded one.
 *
 * This is the only thing standing between "clean up my orphan" and "signal a stranger's
 * process that happens to have reused the pid", so it is deliberately exact-match and
 * fail-closed: a blank reading (process gone, or `ps` unavailable) is a no.
 *
 * `ps` here yields `lstart`, NOT `command` — see `ChildRecord` for the repro that forced
 * the change.
 */
export function stillSameProcess(
  pid: number,
  startedAt: string,
  ps: (pid: number) => string | null,
): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (!startedAt.trim()) return false;
  const current = ps(pid);
  if (!current) return false;
  const norm = (v: string): string => v.replace(/\s+/g, " ").trim();
  return norm(current) === norm(startedAt);
}

/* ------------------------------------------------------------------------- *
 * The registry (layer 1)
 * ------------------------------------------------------------------------- */

let activeHome: string | null = null;
let activeOwner = 0;
const records = new Map<number, ChildRecord>();

/** Persist the current set. Best-effort: a failed write must never break a spawn. */
function flush(): void {
  if (!activeHome) return;
  try {
    const dir = registryDir(activeHome);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = registryPath(activeHome, activeOwner);
    if (records.size === 0) {
      rmSync(path, { force: true });
      return;
    }
    writeFileSync(path, `${serialize([...records.values()])}\n`);
  } catch {
    /* the in-process reaper is still the primary defence; durability is a bonus */
  }
}

/** Begin recording for this run. Returns the registry path (for the sentinel). */
export function openRegistry(home: string, ownerPid: number = process.pid): string {
  activeHome = home;
  activeOwner = ownerPid;
  records.clear();
  return registryPath(home, ownerPid);
}

export function recordChild(rec: ChildRecord): void {
  records.set(rec.pid, rec);
  flush();
}

export function forgetChild(pid: number): void {
  if (records.delete(pid)) flush();
}

/** Drop the whole registry — the run is over and its children are dealt with. */
export function closeRegistry(): void {
  records.clear();
  flush();
  activeHome = null;
}

/* ------------------------------------------------------------------------- *
 * The sentinel (layer 2)
 * ------------------------------------------------------------------------- */

/**
 * A POSIX-sh watchdog: poll the owner; when it is gone, TERM then KILL everything the
 * registry lists whose command line still matches. Written as a single argument-driven
 * script so there is no temp file to clean up and nothing to keep in sync on disk.
 *
 * `sh` and `sleep` cost a few hundred KB and wake twice a minute — cheap enough to always
 * run, which matters because the failure it guards against is unannounced by definition.
 */
export const SENTINEL_SCRIPT = `
owner=$1; reg=$2
# Exit as soon as the owner is gone OR the registry has been removed (normal shutdown).
while kill -0 "$owner" 2>/dev/null; do
  [ -f "$reg" ] || exit 0
  sleep 2
done
[ -f "$reg" ] || exit 0
sig() {
  s=$1
  while IFS='\t' read -r pid grp started cmd; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [ "$pid" -gt 1 ] || continue
    [ -n "$started" ] || continue            # pre-startedAt row: refuse to guess
    # lstart, not command: a shebang/wrapper child's command line CHANGES when the kernel
    # finishes the exec, which made this guard skip every pip/python3 orphan.
    cur=$(LC_ALL=C LANG=C ps -p "$pid" -o lstart= 2>/dev/null | tr -s ' ' | sed 's/^ *//;s/ *$//')
    [ -n "$cur" ] || continue
    [ "$cur" = "$started" ] || continue       # pid-reuse guard: same pid, different process
    if [ "$grp" = "1" ]; then
      kill -"$s" "-$pid" 2>/dev/null || kill -"$s" "$pid" 2>/dev/null
    else
      kill -"$s" "$pid" 2>/dev/null
    fi
  done < "$reg"
}
sig TERM
sleep 5
sig KILL
rm -f "$reg"
`;

/* ------------------------------------------------------------------------- *
 * The startup sweep (layer 3)
 * ------------------------------------------------------------------------- */

export interface SweepDeps {
  /** the pid's START TIME (`ps -o lstart=`), or null when it is gone — the reuse guard. */
  ps: (pid: number) => string | null;
  /** is this pid alive at all? */
  alive: (pid: number) => boolean;
  /** deliver a signal; group === true means the process group. */
  kill: (pid: number, group: boolean, signal: NodeJS.Signals) => void;
}

export interface SweepResult {
  /** registries belonging to dead owners that we adopted. */
  adopted: number;
  /** children actually signalled. */
  killed: ChildRecord[];
  /** recorded pids skipped because the pid now belongs to something else. */
  skippedReused: number;
}

/**
 * Adopt and clean every registry whose owner is dead. Our OWN registry is never touched,
 * and neither is one whose owner is still running — a second concurrent CLI is a normal
 * situation, not an orphan.
 */
export function sweepOrphans(
  home: string,
  deps: SweepDeps,
  selfPid: number = process.pid,
): SweepResult {
  const result: SweepResult = { adopted: 0, killed: [], skippedReused: 0 };
  let files: string[];
  try {
    files = readdirSync(registryDir(home));
  } catch {
    return result; // no registry dir yet — nothing has ever run
  }

  for (const file of files) {
    if (!file.endsWith(".tsv")) continue;
    const owner = Number.parseInt(file.slice(0, -4), 10);
    if (!Number.isInteger(owner) || owner === selfPid) continue;
    if (deps.alive(owner)) continue; // a live sibling CLI — leave it alone

    const path = join(registryDir(home), file);
    let entries: ChildRecord[] = [];
    try {
      entries = parseRegistry(readFileSync(path, "utf8"));
    } catch {
      /* unreadable → still remove it below */
    }
    result.adopted += 1;

    for (const rec of entries) {
      if (!stillSameProcess(rec.pid, rec.startedAt, deps.ps)) {
        // Either already gone (the common case) or the pid now belongs to someone else.
        if (deps.alive(rec.pid)) result.skippedReused += 1;
        continue;
      }
      try {
        deps.kill(rec.pid, rec.group, "SIGTERM");
        result.killed.push(rec);
      } catch {
        /* gone between the check and the signal — fine */
      }
    }
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  }
  return result;
}

/** Reset module state. TESTS ONLY. */
export function __resetForTests(): void {
  records.clear();
  activeHome = null;
  activeOwner = 0;
}
