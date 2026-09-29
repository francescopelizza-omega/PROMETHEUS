/**
 * updates/self-update.ts — how Prometheus updates ITSELF.
 *
 * Prometheus never swaps its own binary while running (AUTO_INSTALL=false ethos). It detects HOW
 * it was installed and hands the user one copyable shell command plus the close→paste→restart
 * steps. PURE: an install method + identifiers in, a command + steps out.
 *
 * ── TWO THINGS THIS FILE HAD WRONG, BOTH MEASURED 2026-09-29 ────────────────────────────────
 *
 * **1. It offered `brew upgrade prometheus`.** There is no Homebrew tap, formula or cask for this
 * project — but `prometheus` IS a real Homebrew formula: the CNCF monitoring server. So a user
 * whose install was (mis)classified as "brew" was handed a command that either upgrades an
 * unrelated monitoring daemon and reports success, or fails with `Error: prometheus not
 * installed` and no fallback, because the `unknown` branch that offers the real options was
 * skipped. `brew` is gone from `InstallMethod` entirely; a brew-looking path is now a DETECTION
 * FAILURE, which routes to `unknown` and offers every real option.
 *
 * **2. It looked for releases on GitHub.** The remote is GitLab —
 * `gitlab.com/red-beard-phoenix/PROMETHEUS`, per `install.sh:25` and `git remote -v`. Every
 * self-check therefore 404'd, `latest` was always undefined, `updateAvailable` was always false,
 * and `formatUpdateReport` printed "(up to date — latest unknown)" forever: a check that could
 * not succeed, rendered as reassurance. It also spent one of GitHub's 60 unauthenticated
 * requests per hour on a guaranteed miss, every time.
 *
 * The real install methods, from `install.sh`: it clones the GitLab repo to `~/.prometheus` and
 * symlinks `~/.local/bin/prometheus` at `<checkout>/bin/prometheus` (install.sh:36, :285). That
 * is a git checkout the user did not make themselves, so it gets its own method — the update is
 * a pull inside a directory they do not know the path of.
 */

/**
 * How the running Prometheus was installed (detected by the CLI layer).
 *
 * No `brew` member: see the header. Adding one back requires a tap to exist first.
 */
export type InstallMethod =
  /** `npm install -g @prometheus/cli`. */
  | "npm-global"
  /** a git checkout the user cloned and runs from. */
  | "git"
  /** `curl … install.sh | sh` — a managed checkout under ~/.prometheus. */
  | "installer"
  | "pipx"
  | "unknown";

export interface SelfUpdateConfig {
  /** the global npm package name for the prometheus CLI. */
  npmPackage: string;
  /**
   * The GitLab project path. NOT a GitHub "owner/repo": the remote is GitLab, and the previous
   * value (`prometheus-studio/prometheus`, queried against api.github.com) could never resolve.
   */
  repo: string;
  /** the python engine entry (for the git/pipx note). */
  engineEntry: string;
  /** where `install.sh` puts its managed checkout. */
  installerHome: string;
  /** the one-liner that installs or re-installs. */
  installerCommand: string;
  /**
   * The npm dist-tag to install.
   *
   * `settings.updateChannel` has been declared, defaulted and VALIDATED since it was added, and
   * nothing ever read it: every command here hardcoded `@latest`, so a user who set "beta" was
   * told their choice was accepted and then handed the stable install command. A setting with no
   * reader is worse than a missing one — it reports success.
   */
  channel: "latest" | "beta" | "alpha";
}

/** Defaults — overridable by the host (e.g. from package.json / a config). */
export const DEFAULT_SELF_UPDATE: SelfUpdateConfig = Object.freeze({
  npmPackage: "@prometheus/cli",
  repo: "red-beard-phoenix/PROMETHEUS",
  engineEntry: "prometheus.py",
  installerHome: "~/.prometheus",
  installerCommand:
    "curl -fsSL https://gitlab.com/red-beard-phoenix/PROMETHEUS/-/raw/main/install.sh | sh",
  channel: "latest",
});

/**
 * Where to ask GitLab what the newest release is.
 *
 * `/releases/permalink/latest` is GitLab's equivalent of GitHub's `/releases/latest` and, like
 * it, resolves to the most recent NON-prerelease. That distinction is load-bearing: ollama's
 * release feed currently titles an entry `v0.40.0` while linking the tag `v0.40.0-rc0`, and an
 * updater reading the feed would announce a general release that does not exist and offer to
 * move a user onto a release candidate. The same rule applies to this project's own updater,
 * which is why it is enforced here rather than left to the caller.
 */
export function gitlabLatestUrl(repo: string): string {
  return `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo)}/releases/permalink/latest`;
}

/** Pull `.tag_name` from a GitLab release document, skipping upcoming/prerelease entries. */
export function latestFromGitlab(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const o = json as { tag_name?: unknown; upcoming_release?: unknown };
  // GitLab marks a not-yet-released entry with `upcoming_release: true`. Announcing one would be
  // offering an upgrade to something that cannot be downloaded.
  if (o.upcoming_release === true) return null;
  return typeof o.tag_name === "string" && o.tag_name.trim() !== "" ? o.tag_name.trim() : null;
}

export interface SelfUpdatePlan {
  method: InstallMethod;
  /** the ONE command to copy + run after closing Prometheus. */
  command: string;
  /** ordered human steps. */
  steps: string[];
  /** true when we couldn't determine the method → both options shown. */
  ambiguous: boolean;
}

export interface BuildSelfUpdateInput {
  method: InstallMethod;
  /** absolute path to the git checkout, when method is "git" or "installer". */
  repoDir?: string;
  config?: Partial<SelfUpdateConfig>;
}

/** Build the self-update plan (command + steps) for the detected install method. */
export function buildSelfUpdatePlan(input: BuildSelfUpdateInput): SelfUpdatePlan {
  const cfg: SelfUpdateConfig = { ...DEFAULT_SELF_UPDATE, ...input.config };
  const restart = "Then start Prometheus again.";
  switch (input.method) {
    case "npm-global": {
      const command = `npm install -g ${cfg.npmPackage}@${cfg.channel}`;
      return {
        method: input.method,
        command,
        steps: ["Close Prometheus (so no file is in use).", `Paste + run:  ${command}`, restart],
        ambiguous: false,
      };
    }
    case "git": {
      const dir = input.repoDir ?? ".";
      const command = `git -C ${dir} pull --ff-only`;
      return {
        method: input.method,
        command,
        steps: [
          "Close Prometheus.",
          `Paste + run:  ${command}`,
          "(if the engine deps changed) re-run your install/setup step.",
          restart,
        ],
        ambiguous: false,
      };
    }
    case "installer": {
      /**
       * `install.sh` clones to ~/.prometheus and symlinks ~/.local/bin/prometheus at it, so the
       * checkout exists but the user has no reason to know where. Re-running the installer is the
       * supported path and is idempotent; the pull is given as the faster alternative, with the
       * real directory filled in so it can be pasted without looking anything up.
       */
      const dir = input.repoDir ?? cfg.installerHome;
      return {
        method: input.method,
        command: cfg.installerCommand,
        steps: [
          "Close Prometheus.",
          `Paste + run:  ${cfg.installerCommand}`,
          `(faster, same result if only the code changed)  git -C ${dir} pull --ff-only`,
          restart,
        ],
        ambiguous: false,
      };
    }
    case "pipx": {
      const command = `pipx upgrade ${cfg.engineEntry.replace(/\.py$/, "")}`;
      return {
        method: input.method,
        command,
        steps: ["Close Prometheus.", `Paste + run:  ${command}`, restart],
        ambiguous: false,
      };
    }
    default: {
      /**
       * Unknown — present every real path, and say plainly that we could not tell.
       *
       * This branch is also where a brew-looking install lands now. That is deliberate: there is
       * no Homebrew package for this project, so a path under a brew prefix means the detection
       * is wrong, not that brew owns it.
       */
      const npm = `npm install -g ${cfg.npmPackage}@${cfg.channel}`;
      return {
        method: "unknown",
        command: `${npm}    # or, if you used the installer:  ${cfg.installerCommand}`,
        steps: [
          "Prometheus could not tell how it was installed. Use the line that matches:",
          "Close Prometheus.",
          `If you installed via npm:  ${npm}`,
          `If you used the install script:  ${cfg.installerCommand}`,
          "If you run from a git checkout:  git -C <prometheus-dir> pull --ff-only",
          restart,
        ],
        ambiguous: true,
      };
    }
  }
}
