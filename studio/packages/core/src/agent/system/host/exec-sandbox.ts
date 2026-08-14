/**
 * agent/system/host/exec-sandbox.ts — OS-ENFORCED confinement for `run_command`
 * (macOS Seatbelt, Linux bubblewrap).
 *
 * ── What this is ────────────────────────────────────────────────────────────────────────
 * Everything else guarding `run_command` is APP-LAYER: the PreToolUse hooks, the A0–A7
 * authorization ladder, the confirm prompt, the nemesis scan, the catastrophic-pattern
 * screen, and the logical path guards. All six decide whether to CALL `spawn`. None of them
 * constrain the process once it is running — a command that talks its way past them has the
 * user's full ambient authority, and one `python3 -c` can then do anything the user can.
 *
 * This module closes that: the approved argv is re-spawned through a kernel confinement
 * driver — `/usr/bin/sandbox-exec` under a generated Seatbelt (SBPL) profile on macOS,
 * `bwrap` (bubblewrap) under a generated mount namespace on Linux — so the KERNEL, not a
 * regex, refuses writes outside the working set and refuses network access below A5.
 *
 * Both platforms are driven from ONE working-set computation (`resolveWorkingSet`) and one
 * network bit (`authAllowsNetwork`). They differ only in how that decision is expressed to
 * the kernel: SBPL text plus `-D` parameters on macOS, an ordered list of bind mounts on
 * Linux. Neither platform has a second, parallel notion of "allowed".
 *
 * ── Where it sits in the order ──────────────────────────────────────────────────────────
 * LAST, and only ever last. The sequence is unchanged and this module is not part of it:
 *
 *   PreToolUse hooks decide  →  ladder / confirm decides  →  nemesis gate decides
 *   →  command screen decides  →  THEN the (now sandboxed) spawn happens
 *
 * It never approves anything, never re-checks anything, and cannot cause a command to run
 * that would not otherwise have run. It only narrows what an already-approved command can do.
 *
 * ── What it ACTUALLY restricts (be precise; this is the part that gets overclaimed) ──────
 *   RESTRICTED — enforced by the kernel:
 *     • File WRITES: denied everywhere except the working set (session cwd + `/add-dir`
 *       roots), the temp dirs, a named list of tool caches, and the standard `/dev` nodes.
 *       Writes to a credential/persistence path are denied even when it sits inside a
 *       writable root (see DENY_HOME_RELATIVE).
 *     • NETWORK: all sockets denied unless the authorization level already auto-approves the
 *       `install` category (A5+) — the same ladder bit that already governs `curl`/`git push`.
 *
 *   NOT RESTRICTED — do not claim otherwise:
 *     • File READS. `(allow file-read*)` is deliberate: Tier-R's purpose is inspecting the
 *       machine (`ls /usr/bin`, `brew list`, `cat /etc/hosts`), and confining reads to the
 *       working set would break the feature outright. Credential-file reads remain guarded
 *       only at the app layer (`isSecretPath` over argv operands), which is a NAME-based
 *       mitigation, not enforcement — a script that reads `~/.ssh/id_ed25519` by a computed
 *       path is not stopped by anything here.
 *     • CPU, memory, disk quota, fork bombs. Seatbelt has no resource limits. The wall-clock
 *       timeout in exec-runner.ts is the only bound.
 *     • `>` / `>>` REDIRECTS. exec-runner opens those files itself, in the HOST process,
 *       BEFORE the sandbox exists, and passes the fd down — so the kernel check never sees
 *       them. They are guarded only by the working-set check in system-tools.ts.
 *     • Anything reachable through a mach service. `(allow mach-lookup)` is unqualified
 *       because dyld and libsystem need it; a determined escape via a system service is not
 *       ruled out.
 *     • The host process. This sandboxes the CHILD. Prometheus itself is unconfined.
 *     • Windows. There is no equivalent primitive and it is out of scope — `{kind:"none"}`.
 *
 *   KNOWN BEHAVIOUR CHANGE: a sandboxed process cannot exec a setuid binary, so `ps`, `top`
 *   and `sudo` fail with "Operation not permitted" where they previously worked. That is the
 *   kernel's rule, not ours, and it is the price of the confinement.
 *
 * ── Linux (bubblewrap): what it restricts, and what it does NOT ─────────────────────────
 * The Linux path builds the SAME working set and re-expresses it as bind mounts, applied in
 * argv order (bwrap: "these are applied in the order they are given as arguments") — the
 * direct analogue of SBPL's last-match-wins. `--ro-bind / /` first, then `--bind` per
 * writable root, then `--ro-bind-try` per denied path, so a deny nested inside a writable
 * root lands on top and wins.
 *
 *   RESTRICTED — enforced by the kernel:
 *     • File WRITES: the whole filesystem is bound READ-ONLY, and only the working set, the
 *       temp dirs and the named tool caches are re-bound writable. Everything else fails
 *       with EROFS ("Read-only file system") rather than EPERM — a different errno from
 *       macOS for the same refusal; `sandboxHint` knows both.
 *     • NETWORK: `--unshare-net` below A5. The same ladder bit as macOS, and it is a real
 *       empty network namespace, not a filter.
 *     • SIGNALS / ptrace against host processes: `--unshare-pid` puts the command in its own
 *       PID namespace, so it cannot see or signal anything outside — the analogue of
 *       Seatbelt's `(allow signal (target self))`.
 *
 *   NOT RESTRICTED on Linux — do not claim otherwise:
 *     • File READS. `--ro-bind / /` is deliberate and is exactly macOS's `(allow file-read*)`:
 *       the whole filesystem stays readable, credential files included. Same non-guarantee,
 *       same app-layer-only mitigation.
 *     • CREATION of a denied path that does not exist yet. `--ro-bind-try` re-binds a deny
 *       path read-only, but bwrap has no "deny" primitive — it composes a view out of mounts,
 *       and there is nothing to mount for a source that is not there. So a session whose cwd
 *       IS `~` can still CREATE a `~/.zshrc` that did not previously exist, where macOS's
 *       SBPL denies the create outright. An EXISTING `~/.zshrc`, `~/.ssh` or
 *       `~/.cargo/credentials.toml` is read-only and cannot be modified. This is the one
 *       place the two platforms genuinely differ in strength, and it is stated rather than
 *       papered over.
 *     • CPU, memory, disk quota, fork bombs. No cgroup limits are applied; the wall-clock
 *       timeout in exec-runner.ts is still the only bound.
 *     • `>` / `>>` REDIRECTS — same as macOS, exec-runner opens them in the HOST process.
 *     • TIOCSTI terminal injection. `--new-session` is deliberately NOT passed, because it
 *       calls setsid() and would detach commands from the controlling terminal. Modern
 *       kernels disable TIOCSTI by default (`dev.tty.legacy_tiocsti=0`); older ones do not.
 *     • Anything reachable through the retained IPC/UTS namespaces, or through a kernel
 *       interface exposed by the fresh `/proc` and `/dev`.
 *
 *   KNOWN BEHAVIOUR CHANGE on Linux: `--unshare-pid` means `ps`, `pgrep` and `lsof` see only
 *   the sandboxed process tree, and inside the user namespace a setuid binary gains nothing,
 *   so `sudo` fails here for the same reason it fails under Seatbelt. On a host where
 *   unprivileged user namespaces are disabled and `bwrap` is not setuid, bwrap itself fails to
 *   start ("No permissions to creating new namespace") and the command does not run — a
 *   refusal, not an unconfined run.
 *
 * ── Fail-closed vs honest-absence (the single most important distinction here) ──────────
 * These are two different answers to two different questions, and conflating them is how a
 * security control becomes either a lie or a denial of service.
 *
 *   `{kind:"error"}` — FAIL CLOSED. A confinement driver IS present on this machine, so this
 *   command was going to be confined, and building that confinement failed. The caller
 *   REFUSES the command. A broken sandbox must never quietly degrade to the app-layer-only
 *   posture. Cases: `sandbox-exec` missing on macOS (it ships with the OS, so its absence
 *   means something is wrong rather than something is unsupported); a writable root that
 *   resolves to `/`, which would confine nothing; on Linux, `bwrap` INSTALLED but the working
 *   set unbuildable.
 *
 *   `{kind:"none"}` — HONEST ABSENCE. There is no confinement primitive here at all, and
 *   there is no action the user could take within this process to get one. Refusing every
 *   command in that state would be a denial of service on a machine that never had a sandbox
 *   to lose, and claiming confinement would be a lie; so the answer states which it is and
 *   the reason is recorded in the exec audit next to every command it ran. Cases: Windows;
 *   Linux with no `bwrap` binary installed; `mode:"off"`.
 *
 * The asymmetry is deliberate: `bwrap` is an optional package, so its ABSENCE is a fact about
 * the machine (⇒ `none`); `sandbox-exec` is part of macOS, so its absence is a fault (⇒
 * `error`). Absence of a driver is never by itself a reason to refuse; failure of a driver
 * that exists always is.
 *
 * ── Why `-D` parameters rather than interpolated paths ──────────────────────────────────
 * Paths are passed as `-D NAME=value` and referenced as `(param "NAME")`, so no user- or
 * repo-controlled string is ever concatenated into profile SOURCE. A directory literally
 * named `x") (allow file-write* (subpath "/")) (;` cannot rewrite the policy — verified
 * live against exactly that name. The profile text itself is a constant plus a count.
 * The whole thing is passed as ONE argv element to a `shell:false` spawn, so this project's
 * long-standing shell-escaping hazards do not apply either.
 *
 * Linux has no equivalent hazard to design around: bwrap takes paths as POSITIONAL operands
 * of `--bind`/`--ro-bind`, never as text inside a policy document, and each one is its own
 * argv element in the same `shell:false` spawn. A directory named `--unshare-all` or
 * `") (allow …` is consumed as an operand, not re-read as an option or as source. The `--`
 * terminator is emitted before the command so nothing in the user's argv can be re-parsed as
 * a bwrap option either.
 *
 * ── Why bubblewrap rather than a direct Landlock binding ────────────────────────────────
 * Landlock (a raw `landlock_create_ruleset`/`landlock_restrict_self` binding) would be the
 * lower-level answer, and it is the wrong one here:
 *   • Node has no Landlock binding. It would mean a compiled N-API addon shipped per
 *     arch/libc — a build-time toolchain requirement and a native artifact in a product that
 *     currently has none, to gain a control that is only available on kernel ≥ 5.13 anyway.
 *   • Landlock covers the FILESYSTEM only. Network would still need a second mechanism
 *     (seccomp, or a network namespace — i.e. most of what bwrap already is). ABI 4 adds
 *     TCP port restrictions, but not on the kernels this would have to support.
 *   • Restricting SELF is the wrong shape: the confinement must apply to the child, after
 *     fork and before exec, which from Node means either a wrapper binary or a `posix_spawn`
 *     hook — i.e. a wrapper binary. bwrap IS that wrapper binary, already written and audited.
 * Shelling out to bwrap also mirrors exactly what the macOS path already does with
 * `sandbox-exec`: one extra argv prefix, no native code, no new process model, and one
 * well-established dependency (bubblewrap is what Flatpak confines every application with).
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import { DEFAULT_AUTH_LEVEL, authLevelMeta } from "../../authorization.js";

/** The Seatbelt driver. Present on every supported macOS; absence is a fail-closed error. */
export const SEATBELT_BIN = "/usr/bin/sandbox-exec";

/**
 * The bubblewrap driver, searched by ABSOLUTE path, in order, first hit wins.
 *
 * Never resolved through PATH. PATH is inherited from a session the model can influence, and
 * "find the program that will confine this command" is the last lookup that should be taking
 * suggestions from it — a `bwrap` earlier on PATH would be handed the argv and asked to run
 * it, which is a sandbox that executes whatever it was told to. Absolute paths only.
 *
 * bubblewrap is an OPTIONAL package on every distro, so an empty result here means "this host
 * has no confinement primitive" (⇒ `{kind:"none"}`), never "something is broken".
 */
export const BWRAP_CANDIDATES: readonly string[] = Object.freeze([
  "/usr/bin/bwrap",
  "/bin/bwrap",
  "/usr/local/bin/bwrap",
  // NixOS puts the whole system profile here and has no /usr/bin to speak of.
  "/run/current-system/sw/bin/bwrap",
]);

/** Host posture, mirroring `gateMode`'s shape. Nothing in the product sets `off` today. */
export type SandboxMode = "enforce" | "off";

/**
 * Does this authorization level already permit the network?
 *
 * Not a new notion: `install` is the ladder category every network-touching program is
 * registered under (`curl`, `wget`, `git push`, `npm install` — see exec/registry.ts), and
 * A5 "installs" is where it becomes auto-approved. Reusing the same bit means the sandbox
 * and the prompt can never disagree about whether this call may reach the network.
 */
export function authAllowsNetwork(level: number): boolean {
  return authLevelMeta(level).auto.includes("install");
}

/**
 * Paths that stay READ-ONLY even when they sit inside a writable root.
 *
 * The working set is normally a project directory, in which case this list is inert. It
 * earns its place in the one case that matters: a session whose cwd IS `~`, where "writable
 * working set" would otherwise mean "may append to `~/.zshrc`" and "may add an SSH key".
 *
 * The credential entries mirror the families `redact.ts`'s SECRET_PATHS already refuses to
 * READ — this is the same list expressed as directories, because SBPL matches paths, not
 * regexes. The rest are persistence vectors (shell init, launch agents): not credentials,
 * but the standard way a command makes itself run again tomorrow.
 *
 * The cargo/maven/gradle entries are NOT hypothetical and are NOT inert: `WRITABLE_HOME_CACHES`
 * grants `~/.cargo`, `~/.m2` and `~/.gradle` wholesale, because that is the only granularity
 * at which those toolchains actually work (cargo writes `registry/`, `git/` and `bin/`; maven
 * writes `repository/`; gradle writes `caches/`, `daemon/`, `wrapper/`). Each of those roots
 * also happens to contain that toolchain's credential file. Granting the root without denying
 * the file back would hand a sandboxed command write access to registry tokens it previously
 * could not touch at all — a NEW hole opened by a convenience fix. Individual files, never
 * their parent directory, exactly as `.npmrc` and `.git-credentials` are handled, and it works
 * for the same reason: the deny block is rendered after the allow block and SBPL is
 * last-match-wins (on Linux, the `--ro-bind-try` is applied after the `--bind`).
 */
const DENY_HOME_RELATIVE: readonly string[] = Object.freeze([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".npmrc",
  ".netrc",
  ".pgpass",
  ".my.cnf",
  ".git-credentials",
  // cargo registry tokens. BOTH spellings: `credentials.toml` is what cargo ≥1.68 writes, and
  // the extensionless `credentials` is the pre-1.39 name — which cargo still reads AND writes
  // in preference to the `.toml` one whenever it exists, so denying only the modern name would
  // leave the file cargo actually uses on such a machine writable.
  ".cargo/credentials.toml",
  ".cargo/credentials",
  // maven: server passwords live in settings.xml (encrypted or not), and the master key that
  // decrypts them lives in settings-security.xml. Both sit directly in the granted `~/.m2`.
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  // gradle: the conventional home for publishing/signing credentials (`signing.password`,
  // `ossrhPassword`), directly inside the granted `~/.gradle`. Gradle reads this file and does
  // not write it, so denying writes costs a build nothing.
  ".gradle/gradle.properties",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".bashrc",
  ".bash_profile",
  ".profile",
  "Library/LaunchAgents",
]);

/** Machine-wide persistence, denied for the same reason as the home-relative launch agents. */
const DENY_ABSOLUTE: readonly string[] = Object.freeze([
  "/Library/LaunchAgents",
  "/Library/LaunchDaemons",
]);

/**
 * Home-relative caches ordinary dev tools must write to or they simply do not run.
 *
 * `pnpm install` writes the content-addressed store, `tsc` and `node` write `~/.cache`,
 * every macOS framework writes `~/Library/Caches`. Confining writes to cwd alone is a
 * sandbox that looks stricter and mostly produces broken builds, so these are named,
 * enumerated and documented rather than discovered one failure at a time.
 *
 * Every path here was checked against the tool's own documentation rather than guessed, and
 * the ones that are DELIBERATELY ABSENT are as load-bearing as the ones present:
 *
 *   • `.cargo`   — CARGO_HOME. Cargo writes `registry/`, `git/` and (for `cargo install`)
 *                  `bin/`. Granting `bin/` is the real cost of making cargo work: it is on
 *                  PATH, so a sandboxed command can leave an executable there for tomorrow.
 *                  Stated, not hidden. `credentials`/`credentials.toml` are denied back.
 *   • `.rustup`  — RUSTUP_HOME (toolchains, components). No credentials live here.
 *   • `.gradle`  — GRADLE_USER_HOME. `gradle.properties` is denied back.
 *   • `.m2`      — maven's local repository. `settings.xml` and `settings-security.xml` are
 *                  denied back.
 *   • `.bun/install/cache` — bun's global install cache, and ONLY that. NOT `~/.bun`, whose
 *                  `bin/` is on PATH by bun's own installer; the cache is what `bun install`
 *                  needs, so the narrower grant is both sufficient and strictly safer.
 *
 * NOT here, because they are already covered or must not be granted:
 *   • deno needs nothing added. DENO_DIR defaults to `~/Library/Caches/deno` on macOS (already
 *     under `Library/Caches`) and `~/.cache/deno` on Linux (already under `.cache`).
 *     `~/.deno` is DENO_INSTALL_ROOT — installed BINARIES on PATH, a persistence vector with
 *     no build-time need — so it is deliberately left unwritable.
 *   • `Library/Caches` is a no-op on Linux and `.cache` is near-dead on macOS; both are kept
 *     in the one list because a path that does not resolve is simply never granted.
 */
const WRITABLE_HOME_CACHES: readonly string[] = Object.freeze([
  "Library/Caches",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".cargo",
  ".rustup",
  ".gradle",
  ".m2",
  ".bun/install/cache",
]);

/** Standard character devices. Without `/dev/null` alone, `git` refuses to start. */
const DEV_WRITABLE: readonly string[] = Object.freeze([
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/dtracehelper",
  "/dev/ptmx",
]);

export interface SandboxRequest {
  /**
   * The allowed-paths set the authorization layer already computed — the session cwd plus
   * every `/add-dir` root (`roots: [state.cwd, ...ws.list()]` at the host call sites). NOT a
   * parallel notion of "allowed": the same array the redirect guard checks against.
   */
  writableRoots: readonly string[];
  /** The authorization level in force. A5+ ⇒ the profile permits network. */
  authLevel?: number;
  mode?: SandboxMode;
  /* ── seams: every one of these is injected by the tests, none by production ──*/
  platform?: NodeJS.Platform;
  home?: string;
  tmpDirs?: readonly string[];
  realpath?: (p: string) => string;
  exists?: (p: string) => boolean;
}

/** A built, ready-to-apply Seatbelt confinement. */
export interface SeatbeltPlan {
  kind: "seatbelt";
  /** the SBPL source, passed as ONE argv element to `sandbox-exec -p`. */
  profile: string;
  /** the `-D NAME=value` pairs, already flattened into argv order. */
  params: readonly string[];
  /** resolved, deduped writable prefixes (for the audit line and for tests). */
  writable: readonly string[];
  /** resolved read-only-anyway prefixes. */
  denied: readonly string[];
  network: boolean;
}

/** A built, ready-to-apply bubblewrap confinement (Linux). */
export interface BwrapPlan {
  kind: "bwrap";
  /** the absolute bwrap path that was found to exist — never resolved through PATH. */
  bin: string;
  /** the full bwrap argv prefix, ordered, terminated by `--`. */
  args: readonly string[];
  /** resolved, deduped writable prefixes (for the audit line and for tests). */
  writable: readonly string[];
  /** paths re-bound read-only on top of the writable ones. */
  denied: readonly string[];
  network: boolean;
}

export type SandboxPlan =
  | SeatbeltPlan
  | BwrapPlan
  /** no confinement is available (or it was explicitly disabled) — the reason is stated. */
  | { kind: "none"; reason: string }
  /** a sandbox was REQUIRED here and could not be built. The caller must refuse. */
  | { kind: "error"; error: string };

/** Canonicalize, or null when the path does not resolve (⇒ it is simply not granted). */
function canonical(p: string, realpath: (q: string) => string): string | null {
  try {
    return realpath(p);
  } catch {
    return null;
  }
}

/**
 * The WORKING SET, computed once and expressed twice.
 *
 * This is the whole security decision: which prefixes may be written, and which paths stay
 * read-only even when nested inside one of them. macOS renders it as SBPL `subpath` filters,
 * Linux as bind mounts, and neither platform is allowed its own opinion about the contents —
 * a divergence here would mean the sandbox meant something different depending on where it
 * ran, which is exactly the class of bug this module exists to make impossible.
 */
function resolveWorkingSet(
  req: SandboxRequest,
  home: string,
  realpath: (p: string) => string,
): { writable: string[]; denied: string[] } | { error: string } {
  const writable: string[] = [];
  const push = (p: string): void => {
    const real = canonical(p, realpath);
    if (!real) return; // does not exist ⇒ nothing can be written there ⇒ nothing to grant
    if (!writable.includes(real)) writable.push(real);
  };

  for (const root of req.writableRoots) {
    const real = canonical(root, realpath);
    if (!real) continue;
    // `(subpath "/")` — or `--bind / /` — is not a sandbox, it is a sandbox-shaped no-op.
    // Refuse rather than hand back a policy that permits every write on the machine.
    if (real === sep) {
      return {
        error: "a writable root resolved to the filesystem root, which would confine nothing",
      };
    }
    push(real);
  }
  const tmps = req.tmpDirs ?? [tmpdir(), "/tmp"];
  for (const t of tmps) push(t);
  for (const c of WRITABLE_HOME_CACHES) push(join(home, c));

  /* ── denied-anyway set ─────────────────────────────────────────────────────*/
  // NOT realpath'd and NOT existence-checked: `~/.ssh` may not exist yet, and denying the
  // path a command would CREATE is the entire point on macOS. SBPL is happy with a path that
  // is not there; a symlinked `~/.ssh` is covered because the deny is evaluated on the
  // resolved path the kernel sees, and the resolved target is usually inside home too — a
  // home whose `.ssh` is symlinked outside the writable roots is denied by the root scope
  // anyway. On Linux a non-existent entry is skipped by `--ro-bind-try` instead; see the
  // header's explicit note that Linux therefore does not deny the CREATE.
  const denied = [...DENY_HOME_RELATIVE.map((d) => join(home, d)), ...DENY_ABSOLUTE];
  return { writable, denied };
}

/**
 * Decide the confinement for ONE command.
 *
 * Pure apart from the two filesystem seams, so the profile can be asserted on in a unit test
 * without a spawn — but note that a profile which only ever passes a unit test proves
 * nothing. The live checks in exec-sandbox.test.ts run the real `sandbox-exec`.
 */
export function planExecSandbox(req: SandboxRequest): SandboxPlan {
  const mode = req.mode ?? "enforce";
  const platform = req.platform ?? process.platform;
  const realpath = req.realpath ?? ((p: string) => realpathSync.native(p));
  const exists = req.exists ?? ((p: string) => existsSync(p));

  if (mode === "off") {
    return { kind: "none", reason: "the host disabled the exec sandbox (sandboxMode: off)" };
  }
  if (platform !== "darwin" && platform !== "linux") {
    // Honest absence, not fail-closed: there is no primitive to use here at all, so refusing
    // every command would be a denial of service and claiming confinement would be a lie.
    return {
      kind: "none",
      reason: `no OS-level exec sandbox is implemented for ${platform} (macOS Seatbelt and Linux bubblewrap only; Windows has no equivalent primitive)`,
    };
  }

  const home = req.home ?? homedir();
  const network = authAllowsNetwork(req.authLevel ?? DEFAULT_AUTH_LEVEL);

  if (platform === "linux") {
    // Order matters, and it is the fail-closed/honest-absence distinction in code: look for a
    // driver FIRST. With no bwrap on the box there is no confinement to fail at, whatever the
    // working set would have been — that is `none`. Only once a driver is known to be present
    // does a failure to build become a refusal.
    const bin = BWRAP_CANDIDATES.find((p) => exists(p));
    if (!bin) {
      return {
        kind: "none",
        reason:
          "bubblewrap (bwrap) is not installed, so no OS-level confinement is available on this Linux host — install it (e.g. `apt install bubblewrap`) to have run_command confined by the kernel",
      };
    }
    const set = resolveWorkingSet(req, home, realpath);
    if ("error" in set) {
      // FAIL CLOSED: bwrap exists, so this command was going to be confined and now cannot be.
      return { kind: "error", error: set.error };
    }
    return {
      kind: "bwrap",
      bin,
      args: buildBwrapArgs({ writable: set.writable, denied: set.denied, network }),
      writable: set.writable,
      denied: set.denied,
      network,
    };
  }

  // macOS. `sandbox-exec` ships with the OS, so its ABSENCE is a fault rather than an
  // unsupported platform — fail closed, never `none`.
  if (!exists(SEATBELT_BIN)) {
    return {
      kind: "error",
      error: `${SEATBELT_BIN} is missing, so the command cannot be confined`,
    };
  }

  const set = resolveWorkingSet(req, home, realpath);
  if ("error" in set) return { kind: "error", error: set.error };
  const { writable, denied } = set;

  const params: string[] = [];
  writable.forEach((p, i) => params.push("-D", `${writeParam(i)}=${p}`));
  denied.forEach((p, i) => params.push("-D", `${denyParam(i)}=${p}`));

  return {
    kind: "seatbelt",
    profile: buildSeatbeltProfile({
      writeCount: writable.length,
      denyCount: denied.length,
      network,
    }),
    params,
    writable,
    denied,
    network,
  };
}

const writeParam = (i: number): string => `PROM_W${i}`;
const denyParam = (i: number): string => `PROM_D${i}`;

/**
 * Render the SBPL source.
 *
 * Order is load-bearing: SBPL is LAST-MATCH-WINS, so the deny block must come after the
 * allow block or `~/.ssh` inside a writable root would stay writable. Verified live.
 *
 * The counts (not the paths) are the only variable input — see the module header.
 */
export function buildSeatbeltProfile(opts: {
  writeCount: number;
  denyCount: number;
  network: boolean;
}): string {
  const lines: string[] = [
    "(version 1)",
    ";; Prometheus exec sandbox — generated per command. Deny everything, re-allow the minimum.",
    "(deny default)",
    "",
    ";; the shell and the tools it runs must be able to exec, fork and signal their own children.",
    "(allow process-exec*)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow process-info* (target self))",
    "",
    ";; dyld, libsystem and the ordinary process-startup path.",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    "",
    ";; READS ARE NOT CONFINED. Deliberate — see the module header for exactly why, and for",
    ";; what that does and does not leave protected.",
    "(allow file-read*)",
    "",
  ];

  if (opts.writeCount > 0) {
    // Guarded: `(allow file-write*)` with NO filter allows every write on the machine, so an
    // empty writable set must never render this form.
    const subpaths = Array.from(
      { length: opts.writeCount },
      (_, i) => `    (subpath (param "${writeParam(i)}"))`,
    );
    lines.push(";; writes: the working set + temp + the named tool caches, and nothing else.");
    lines.push("(allow file-write*", ...subpaths, ")");
  } else {
    lines.push(";; no writable root resolved — every filesystem write is denied.");
  }

  lines.push(
    "",
    ";; the standard character devices (git will not even start without /dev/null).",
    `(allow file-write* ${DEV_WRITABLE.map((d) => `(literal "${d}")`).join(" ")} (subpath "/dev/fd"))`,
    `(allow file-ioctl ${DEV_WRITABLE.map((d) => `(literal "${d}")`).join(" ")})`,
    "",
  );

  if (opts.denyCount > 0) {
    const filters = Array.from({ length: opts.denyCount }, (_, i) => {
      const p = `(param "${denyParam(i)}")`;
      // both forms: `literal` catches the file itself, `subpath` catches everything under it.
      return `    (literal ${p}) (subpath ${p})`;
    });
    lines.push(
      ";; …and never these, even when they sit INSIDE a writable root (last match wins).",
      "(deny file-write*",
      ...filters,
      ")",
      "",
    );
  }

  lines.push(
    opts.network
      ? ";; A5+ already auto-approves the `install` category, so the network stays open."
      : ";; below A5 the ladder does not auto-approve network work, so the kernel refuses it.",
    opts.network ? "(allow network*)" : "(deny network*)",
    "",
  );

  return lines.join("\n");
}

/**
 * Render the bubblewrap argv prefix — the Linux expression of the same working set.
 *
 * ORDER IS THE POLICY. bwrap applies mount operations "in the order they are given as
 * arguments", so this reads top to bottom exactly like the SBPL profile does:
 *
 *   1. `--ro-bind / /`     the entire filesystem, readable, writable nowhere. This is both
 *                          halves of the macOS policy at once: `(allow file-read*)` — reads
 *                          are deliberately NOT confined — and the `(deny default)` for
 *                          writes, which surface as EROFS instead of EPERM.
 *   2. `--proc` / `--dev`  a fresh procfs (required once the PID namespace is unshared, or
 *                          the sandbox would read the host's `/proc`) and a minimal devtmpfs,
 *                          which is where DEV_WRITABLE's nodes come from on this platform:
 *                          bwrap creates null/zero/full/random/urandom/tty, the `/dev/pts`
 *                          pair and the `/dev/fd`, `/dev/std*` symlinks. Without them `git`
 *                          does not start, same as on macOS.
 *   3. `--bind` × writable the working set, temp and the named tool caches, mounted OVER the
 *                          read-only root, which is why they end up writable.
 *   4. `--ro-bind-try` × denied  the credential and persistence paths, mounted back read-only
 *                          OVER the writable roots. Last one wins, so `~/.ssh` inside a
 *                          writable home is read-only again — the same inversion the SBPL
 *                          deny block performs, achieved by ordering rather than by a rule.
 *                          `-try` because the deny list is deliberately not existence-checked
 *                          and plain `--ro-bind` aborts on a missing source; the cost is that
 *                          a deny path which does not exist yet is skipped, and Linux
 *                          therefore does not prevent its CREATION (stated in the header).
 *
 * `--unshare-pid` isolates the process tree (no signalling or ptracing host processes — the
 * analogue of Seatbelt's `(allow signal (target self))`), `--unshare-net` is the A5 network
 * bit, and `--die-with-parent` makes the whole sandbox die with the runner so the timeout's
 * group kill cannot leave a namespace behind.
 *
 * Every path is a positional operand in its own argv element, so no path can be re-read as an
 * option and none is ever concatenated into a policy document. `--` terminates bwrap's own
 * option parsing before the command's argv begins.
 */
export function buildBwrapArgs(opts: {
  writable: readonly string[];
  denied: readonly string[];
  network: boolean;
}): string[] {
  const args: string[] = [
    "--die-with-parent",
    "--unshare-pid",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  if (!opts.network) args.push("--unshare-net");
  for (const p of opts.writable) args.push("--bind", p, p);
  for (const p of opts.denied) args.push("--ro-bind-try", p, p);
  args.push("--");
  return args;
}

/**
 * Apply a plan to one stage's argv.
 *
 * `sandbox-exec` execve()s the target in place, so the pid, the process group and the
 * `ps`-visible command line are all unchanged — the timeout's group kill and the orphan
 * reaper keep working exactly as they did. `bwrap` forks rather than exec'ing in place (it
 * must — something has to be PID 1 of the new namespace), so the pid the runner holds is
 * bwrap's. That does not break the timeout: process groups are inherited across that fork and
 * are host-visible, so the runner's `kill(-pgid)` still reaches everything, and
 * `--die-with-parent` SIGKILLs the whole sandbox if the runner dies first — closing the orphan
 * case rather than opening one.
 */
export function sandboxArgv(plan: SandboxPlan | undefined, argv: readonly string[]): string[] {
  if (!plan) return [...argv];
  if (plan.kind === "seatbelt") return [SEATBELT_BIN, "-p", plan.profile, ...plan.params, ...argv];
  if (plan.kind === "bwrap") return [plan.bin, ...plan.args, ...argv];
  return [...argv];
}

/**
 * Explain a failure the SANDBOX caused, so the model re-plans instead of retrying forever.
 *
 * Two failure shapes are ours rather than the command's, and both look like ordinary tool
 * failures unless something says otherwise:
 *
 *   • `sandbox-exec: execvp() … Operation not permitted` — a sandboxed process may not exec a
 *     SETUID binary. `ps`, `top` and `sudo` are setuid on macOS, so they simply do not run
 *     here. Nothing can be configured to change that; it is the kernel's rule.
 *   • a write refused with `Operation not permitted` — the path is outside the working set.
 *     The actionable move is `/add-dir`, which the model cannot guess from `EPERM` alone.
 *
 * The Linux equivalents differ only in the errno the kernel reports for the same refusal: a
 * write outside the working set lands on a read-only bind mount, so it is EROFS ("Read-only
 * file system"), not EPERM. Matching only the macOS wording would silently drop the hint on
 * the platform whose error message is the LEAST self-explanatory. bwrap's own startup
 * failures (a host with unprivileged user namespaces disabled) are prefixed `bwrap:` and get
 * their own answer, because nothing about "creating new namespace" tells the model that the
 * command never ran.
 *
 * Returns null when nothing in the output looks sandbox-caused; a hint on every EPERM would
 * be a lie whenever the real cause was file permissions.
 */
export function sandboxHint(plan: SandboxPlan | undefined, stderr: string): string | null {
  if (!plan || (plan.kind !== "seatbelt" && plan.kind !== "bwrap")) return null;
  if (/sandbox-exec: execvp\(\)/.test(stderr)) {
    return "note: the OS sandbox cannot exec a setuid binary (ps, top, sudo). This is a kernel rule, not a setting — use a non-setuid alternative.";
  }
  if (plan.kind === "bwrap" && /^bwrap:/m.test(stderr)) {
    return "note: the OS sandbox (bubblewrap) could not start, so the command did not run at all. This usually means the host has unprivileged user namespaces disabled and bwrap is not setuid — a machine configuration the command itself cannot work around.";
  }
  if (/Operation not permitted|Read-only file system/i.test(stderr)) {
    return `note: the OS sandbox allows writes only inside the working set (${
      plan.writable.length
    } root(s)), the temp dirs and the standard tool caches${
      plan.network ? "" : ", and denies network access below authorization level 5"
    }. If the path is legitimate, the human can add it with /add-dir.`;
  }
  if (
    !plan.network &&
    /Could not resolve host|Couldn't connect|Network is unreachable|Temporary failure in name resolution/i.test(
      stderr,
    )
  ) {
    return "note: the OS sandbox denies network access below authorization level 5 (the level at which the ladder already auto-approves installs/fetches).";
  }
  return null;
}

/** One line for the exec audit / the refusal message. */
export function describeSandbox(plan: SandboxPlan): string {
  if (plan.kind === "error") return `sandbox unavailable: ${plan.error}`;
  if (plan.kind === "none") return `unsandboxed (${plan.reason})`;
  return `${plan.kind}: ${plan.writable.length} writable root(s), network ${
    plan.network ? "allowed" : "denied"
  }`;
}
