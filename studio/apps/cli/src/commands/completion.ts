// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/completion.ts — `prometheus completion bash|zsh|fish` shell-completion generators (CLI-100).
 *
 * The command + flag names are derived EXCLUSIVELY from CLI-049's `COMMAND_SPECS` registry (the same
 * source the parity router + help use) — never a hand-maintained list, so adding/removing a command
 * updates the completions automatically (regression-guarded in the test).
 *
 * SECURITY: a generated completion script runs in the user's shell startup. Every interpolated
 * command/flag name is validated to `[A-Za-z0-9:_-]` and any name with a shell metacharacter is
 * DROPPED (never emitted unquoted) — a malformed name can't break the user's shell. Descriptions are
 * escaped per-shell (zsh `:` + quotes, fish `'`). Pure string builders — no IO.
 */
import { COMMAND_SPECS } from "@prometheus/core";

import { ROUTED_VERBS } from "../route-table.js";

import type { CliContext, CommandOutcome } from "../context.js";

/** Global flags every `prometheus` invocation accepts (parse.ts §1 globals) — completed after any command. */
const GLOBAL_FLAGS = [
  "--json",
  "--no-color",
  "--quiet",
  "--dry-run",
  "--yes",
  "--force",
  "--profile",
  "--gate-mode",
  "--effort",
  "--force-effort",
  "--help",
  "--version",
] as const;

/** A name is completion-safe iff it has no shell metacharacter (command ids/flags are clean; guard anyway). */
function isSafeName(name: string): boolean {
  return /^[A-Za-z0-9:_-]+$/.test(name);
}

/**
 * The verbs a user can actually type, sorted, deduped and metachar-free.
 *
 * This used to map `COMMAND_SPECS` to their `id`, but a spec id is an INTERNAL identifier, not
 * the token a user types: `env-list` is the spec behind `prometheus env list`. So the generated
 * completion offered `env-list`, `model-hw`, `provider-list` and `secure-scan` — every one of
 * which exits 2 with "unknown command" — while omitting 32 verbs that do exist (`mcp`, `env`,
 * `model`, `repo`, `keymap`, `sessions`, `profile`, `agents`, `metadata`, …). Measured by
 * running each one against the built binary.
 *
 * `ROUTED_VERBS` is the router's own list — the same one `index.ts` uses to suggest a nearest
 * match — and it already excludes those four internal ids by name (`INTERNAL_SPEC_IDS`). The
 * exclusion existed; this generator simply was not reading it.
 */
export function completionCommands(): string[] {
  return [...new Set(ROUTED_VERBS)].filter(isSafeName).sort();
}

/** Every flag name across the registry + the globals, as `--name` (deduped, safe, sorted). */
export function completionFlags(): string[] {
  const flags = new Set<string>(GLOBAL_FLAGS);
  for (const c of COMMAND_SPECS) {
    for (const f of c.argsSchema.flags ?? []) {
      const flag = `--${f.name}`;
      if (isSafeName(f.name)) flags.add(flag);
    }
  }
  return [...flags].sort();
}

/** One-line, shell-safe description for a command (collapsed whitespace, truncated). */
function shortDesc(id: string): string {
  const spec = COMMAND_SPECS.find((c) => c.id === id);
  const raw = spec?.help?.synopsis ?? spec?.description ?? id;
  return raw.replace(/\s+/g, " ").trim().slice(0, 72);
}

/**
 * bash completion (CLI-100): `complete -F _prometheus prometheus`. Commands complete at word 1, flags
 * when the current word starts with `-`. The wordlists are space-joined validated names, so no
 * word-splitting/glob hazard.
 */
export function bashCompletion(): string {
  const cmds = completionCommands().join(" ");
  const flags = completionFlags().join(" ");
  return `# prometheus bash completion — eval "$(prometheus completion bash)"
_prometheus() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmds="${cmds}"
  local flags="${flags}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\$cmds" -- "\$cur") )
  elif [[ "\$cur" == -* ]]; then
    COMPREPLY=( \$(compgen -W "\$flags" -- "\$cur") )
  fi
}
complete -F _prometheus prometheus
`;
}

/** zsh description escaping: backslash, then single-quote (`'\''`, since the entry is single-quoted),
 *  then `:` (the `_describe` name:desc separator). Order matters — backslash first. */
function zshDesc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:");
}

/**
 * zsh completion (CLI-100): `#compdef prometheus` + `_describe`. Install the ROBUST way — save
 * as a `_prometheus` file on `$fpath` BEFORE compinit (the README documents this) — `eval` also works.
 */
export function zshCompletion(): string {
  const lines = completionCommands().map((id) => `    '${id}:${zshDesc(shortDesc(id))}'`);
  const flags = completionFlags()
    .map((f) => `'${f}'`)
    .join(" ");
  return `#compdef prometheus
_prometheus() {
  local -a _prometheus_cmds
  _prometheus_cmds=(
${lines.join("\n")}
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'prometheus command' _prometheus_cmds
  else
    _values 'flag' ${flags}
  fi
}
_prom "\$@"
`;
}

/** fish description escaping: single quotes (the `-d '...'` delimiter). */
function fishDesc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * fish completion (CLI-100): `complete -c prometheus …`. Save to `~/.config/fish/completions/prometheus.fish`
 * (auto-loaded — no eval). Subcommands via `__fish_use_subcommand`; flags always.
 */
export function fishCompletion(): string {
  const out = [
    "# prometheus fish completion — save to ~/.config/fish/completions/prometheus.fish",
    "complete -c prometheus -f",
  ];
  for (const id of completionCommands()) {
    out.push(
      `complete -c prometheus -n '__fish_use_subcommand' -a '${id}' -d '${fishDesc(shortDesc(id))}'`,
    );
  }
  for (const f of completionFlags()) {
    out.push(`complete -c prometheus -l '${f.replace(/^--/, "")}'`);
  }
  return `${out.join("\n")}\n`;
}

// Prototype-free map: a plain object literal would resolve `constructor`/`__proto__`/`toString`
// via Object.prototype, so `prometheus completion constructor` would return a truthy generator and skip
// the unknown-shell branch. Object.create(null) has no inherited keys — only bash/zsh/fish match.
const GENERATORS: Record<string, () => string> = Object.assign(Object.create(null), {
  bash: bashCompletion,
  zsh: zshCompletion,
  fish: fishCompletion,
});

/** `prometheus completion <bash|zsh|fish>` — print the generated script to stdout. */
export function runCompletion(ctx: CliContext): CommandOutcome {
  const shell = (ctx.args.command[1] ?? ctx.args.positionals[0] ?? "").toLowerCase();
  const gen = GENERATORS[shell];
  if (!gen) {
    const valid = Object.keys(GENERATORS).join(" | ");
    const msg = `prometheus completion: specify a shell — ${valid}`;
    return {
      text: msg,
      json: { ok: false, error: "bad-shell", valid: Object.keys(GENERATORS) },
      exitCode: 2,
    };
  }
  if (ctx.json) return { json: { ok: true, shell, script: gen() }, exitCode: 0 };
  return { text: gen(), exitCode: 0 };
}
