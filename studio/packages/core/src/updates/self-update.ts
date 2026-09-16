/**
 * updates/self-update.ts — how Prometheus updates ITSELF.
 *
 * Prometheus never swaps its own binary while running (AUTO_INSTALL=false ethos). Instead it
 * detects HOW it was installed and hands the user a single copyable shell command + the
 * close→paste→restart steps. PURE: an install method + identifiers in, a command + steps out.
 * The CLI layer detects the method (where the bin resolves, is it a git checkout) and fetches
 * the latest version for the delta — all fail-soft, so the update command always renders.
 */

/** How the running Prometheus was installed (detected by the CLI layer). */
export type InstallMethod = "npm-global" | "git" | "brew" | "pipx" | "unknown";

export interface SelfUpdateConfig {
  /** the global npm package name for the prometheus CLI. */
  npmPackage: string;
  /** the GitHub "owner/repo" of the source checkout (for the git path + releases). */
  repo: string;
  /** the python engine entry (for the git/pipx note). */
  engineEntry: string;
  /**
   * The npm dist-tag to install.
   *
   * `settings.updateChannel` has been declared, defaulted and VALIDATED since it was added,
   * and nothing ever read it: every command here hardcoded `@latest`, so a user who set
   * "beta" was told their choice was accepted and then handed the stable install command.
   * A setting with no reader is worse than a missing one — it reports success.
   */
  channel: "latest" | "beta" | "alpha";
}

/** Defaults — overridable by the host (e.g. from package.json / a config). */
export const DEFAULT_SELF_UPDATE: SelfUpdateConfig = Object.freeze({
  npmPackage: "@prometheus/cli",
  repo: "prometheus-studio/prometheus",
  engineEntry: "prometheus.py",
  channel: "latest",
});

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
  /** absolute path to the git checkout, when method === "git". */
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
    case "brew": {
      const command = "brew upgrade prometheus";
      return {
        method: input.method,
        command,
        steps: ["Close Prometheus.", `Paste + run:  ${command}`, restart],
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
      // Unknown install — present the two most likely paths.
      const command = `npm install -g ${cfg.npmPackage}@${cfg.channel}    # or, from a git checkout:  git pull --ff-only`;
      return {
        method: "unknown",
        command,
        steps: [
          "Close Prometheus.",
          `If you installed via npm:  npm install -g ${cfg.npmPackage}@${cfg.channel}`,
          "If you run from a git checkout:  git -C <prometheus-dir> pull --ff-only",
          restart,
        ],
        ambiguous: true,
      };
    }
  }
}
