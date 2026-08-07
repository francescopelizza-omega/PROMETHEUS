import { existsSync } from "node:fs";
/**
 * commands/profile.ts — `prometheus profile …` + `prometheus config …` (file 11 §6, prom-native).
 *
 * Profiles bundle agent tuning + engine defaults, shared with the GUI under
 * ~/.config/prometheus-studio/profiles/. `profile use/new/edit/list` are REAL (CLI-044):
 * `use` persists the active profile, `new` scaffolds a TOML from a seed, `edit` opens $EDITOR
 * (copy-on-write for builtins), `list` merges builtin + user with the active one marked.
 * `config get/set` are REAL TOML-backed reads/writes against config.toml (CLI-005).
 */
import { cliProfiles } from "@prometheus/core";

import type { CliContext, CommandOutcome } from "../context.js";
import {
  defaultOpenEditor,
  getActiveProfileName,
  listUserProfileNames,
  loadProfile,
  profileExists,
  readConfigRaw,
  setActiveProfileName,
  writeTextAtomic,
} from "../profile-store.js";
import { padEnd, visibleLen } from "../render.js";

/** Injectable seams so `profile edit` is unit-testable without spawning a real editor. */
export interface ProfileCmdDeps {
  openEditor: (file: string) => number;
  isTTY: boolean;
}
const defaultProfileDeps: ProfileCmdDeps = {
  openEditor: defaultOpenEditor,
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
};

/** Coerce a `config set` value literal: true/false → bool, numeric → number, else string. */
function coerceConfigValue(raw: string): cliProfiles.TomlValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw) || /^-?\d+\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** Render a scalar/array value for human text output. */
function formatConfigValue(v: cliProfiles.TomlValue | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(v);
}

const missingName = (sub: string): CommandOutcome => ({
  text: `prometheus profile ${sub}: needs a profile name`,
  json: { ok: false, error: "missing-name" },
  exitCode: 2,
});

/** A profile name becomes `<name>.toml` under the profiles dir — so it must be a plain filename with
 *  NO path separator or `.`/`..` traversal (mirrors safeSessionId), else `prometheus profile new ../x`
 *  would write outside the sandbox. */
function isSafeProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}
const badProfileName = (sub: string, name: string): CommandOutcome => ({
  text: `prometheus profile ${sub}: invalid name "${name}" — use letters/digits/._- only (no path separators)`,
  json: { ok: false, error: "bad-name", id: name },
  exitCode: 2,
});

/** `prometheus profile [list|use <name>|new <name> [--seed b]|edit <name>]`. */
export function runProfile(
  path: string[],
  ctx: CliContext,
  deps: ProfileCmdDeps = defaultProfileDeps,
): CommandOutcome {
  const sub = path[1] ?? "list";
  const name = ctx.args.positionals[0];

  if (sub === "list") {
    const active = getActiveProfileName() ?? cliProfiles.DEFAULT_PROFILE_NAME;
    const entries = cliProfiles.listProfiles(listUserProfileNames());
    const rows = entries.map((e) => ({ ...e, active: e.name === active }));
    const lines = entries.map((e) => {
      const mark = e.name === active ? "*" : " ";
      const tag =
        e.source === "user"
          ? cliProfiles.getCliProfile(e.name)
            ? " (user, shadows builtin)"
            : " (user)"
          : "";
      return `  ${mark} ${e.name}${tag}`;
    });
    return {
      text: `profiles (${active} active):\n${lines.join("\n")}\n(dir: ${cliProfiles.profilesDir()})`,
      json: { ok: true, active, profiles: rows },
      exitCode: 0,
    };
  }

  if (sub === "use") {
    if (!name) return missingName(sub);
    if (!isSafeProfileName(name)) return badProfileName(sub, name);
    if (!profileExists(name)) {
      return {
        text: `prometheus profile use: no such profile "${name}" (builtin or ${cliProfiles.profilePath(name)})`,
        json: { ok: false, error: "unknown-profile", id: name },
        exitCode: 2,
      };
    }
    const prev = getActiveProfileName() ?? cliProfiles.DEFAULT_PROFILE_NAME;
    setActiveProfileName(name);
    return {
      text: `active profile: ${prev} → ${name}`,
      json: { ok: true, active: name, previous: prev },
      exitCode: 0,
    };
  }

  if (sub === "new") {
    if (!name) return missingName(sub);
    if (!isSafeProfileName(name)) return badProfileName(sub, name);
    const seedName =
      typeof ctx.args.flags?.seed === "string"
        ? ctx.args.flags.seed
        : cliProfiles.DEFAULT_PROFILE_NAME;
    const seed = cliProfiles.getCliProfile(seedName);
    if (!seed) {
      return {
        text: `prometheus profile new: unknown --seed "${seedName}" (builtins: ${Object.keys(cliProfiles.BUILTIN_CLI_PROFILES).join(", ")})`,
        json: { ok: false, error: "unknown-seed", seed: seedName },
        exitCode: 2,
      };
    }
    const file = cliProfiles.profilePath(name);
    if (existsSync(file)) {
      return {
        text: `prometheus profile new: "${name}" already exists at ${file} (refusing to overwrite)`,
        json: { ok: false, error: "exists", path: file },
        exitCode: 2,
      };
    }
    const toml = cliProfiles.serializeProfile({ ...seed, name });
    if (!cliProfiles.parseProfile(toml, name)) {
      return {
        text: "prometheus profile new: internal error — scaffolded TOML did not round-trip",
        json: { ok: false, error: "bad-scaffold" },
        exitCode: 2,
      };
    }
    writeTextAtomic(file, toml);
    return {
      text: `created profile ${name} (from seed ${seedName}) → ${file}\nedit it: prometheus profile edit ${name}`,
      json: { ok: true, id: name, seed: seedName, path: file },
      exitCode: 0,
    };
  }

  if (sub === "edit") {
    if (!name) return missingName(sub);
    if (!isSafeProfileName(name)) return badProfileName(sub, name);
    const file = cliProfiles.profilePath(name);
    if (!existsSync(file)) {
      // builtin → COPY the seed to the user dir first (copy-on-write; never mutate the frozen seed).
      const seed = cliProfiles.getCliProfile(name);
      if (!seed) {
        return {
          text: `prometheus profile edit: no such profile "${name}" (builtin or ${file})`,
          json: { ok: false, error: "unknown-profile", id: name },
          exitCode: 2,
        };
      }
      writeTextAtomic(file, cliProfiles.serializeProfile({ ...seed, name }));
    }
    if (ctx.json || !deps.isTTY) {
      // non-TTY / --json: never block on a spawned editor — just report the path.
      return {
        text: `profile file: ${file}\n(non-interactive — open it in your editor manually)`,
        json: { ok: true, id: name, path: file, opened: false },
        exitCode: 0,
      };
    }
    const code = deps.openEditor(file);
    const reparsed = cliProfiles.parseProfile(readConfigRaw(file), name);
    if (!reparsed) {
      return {
        text: `⚠ ${file} does not parse as a valid profile after editing — fix agent.model (the one required key)`,
        json: { ok: false, id: name, path: file, error: "parse-failed", editorExit: code },
        exitCode: 2,
      };
    }
    return {
      text: `saved profile ${name} (${file})`,
      json: { ok: true, id: name, path: file, editorExit: code },
      exitCode: 0,
    };
  }

  return { text: `prometheus profile: unknown action "${sub}"`, json: { ok: false }, exitCode: 2 };
}

/** `prometheus config [path|get <key>|set <key> <value>]` — real TOML-backed reads/writes. */
export function runConfig(path: string[], ctx: CliContext): CommandOutcome {
  const sub = path[1] ?? "path";
  if (sub === "path") {
    const dir = cliProfiles.configDir();
    return { text: dir, json: { ok: true, configDir: dir }, exitCode: 0 };
  }

  const file = cliProfiles.configPath();

  if (sub === "get") {
    const key = ctx.args.positionals[0];
    if (!key) {
      return {
        text: "prometheus config get: needs a key (e.g. `prometheus config get a.b.c`)",
        json: { ok: false, error: "missing-key" },
        exitCode: 2,
      };
    }
    const table = cliProfiles.parseToml(readConfigRaw(file));
    const value = cliProfiles.getPath(table, key);
    if (value === undefined) {
      return {
        text: `config get: unknown key "${key}"`,
        json: { ok: false, key, error: "unknown-key" },
        exitCode: 2,
      };
    }
    return { text: formatConfigValue(value), json: { ok: true, key, value }, exitCode: 0 };
  }

  if (sub === "set") {
    const key = ctx.args.positionals[0];
    const rawValue = ctx.args.positionals[1];
    if (!key || rawValue === undefined) {
      return {
        text: "prometheus config set: needs <key> <value> (e.g. `prometheus config set a.b 1`)",
        json: { ok: false, error: "usage" },
        exitCode: 2,
      };
    }
    const raw = readConfigRaw(file);
    const table = cliProfiles.parseToml(raw);
    const coerced = coerceConfigValue(rawValue);
    // schema enforcement (CLI-045): a type mismatch on a KNOWN key is a hard refusal; an unknown
    // key WARNS (+ suggestion) but still writes so forward-compat keys survive.
    const spec = cliProfiles.CONFIG_SCHEMA[key];
    let suggestionText = "";
    let suggestionKey: string | undefined;
    if (spec) {
      const actual = cliProfiles.valueType(coerced);
      if (actual !== spec.type) {
        return {
          text: `config set: key "${key}" expects ${spec.type}, got ${actual} (${rawValue})`,
          json: { ok: false, key, error: "type-mismatch", expected: spec.type, actual },
          exitCode: 2,
        };
      }
    } else {
      suggestionKey = cliProfiles.nearestKey(key, Object.keys(cliProfiles.CONFIG_SCHEMA));
      suggestionText = `⚠ unknown config key "${key}"${suggestionKey ? ` — did you mean "${suggestionKey}"?` : ""}\n`;
    }
    cliProfiles.setPath(table, key, coerced);
    try {
      writeTextAtomic(file, cliProfiles.stringifyToml(table));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        text: `config set: write failed: ${detail}`,
        json: { ok: false, key, error: "write-failed", detail },
        exitCode: 2,
      };
    }
    const value = cliProfiles.getPath(table, key);
    // the rewrite is comment-free + reordered — warn ONCE in text mode (never in --json).
    const warn = raw.includes("#")
      ? `⚠ rewrote ${file} without comments (the config parser is comment-free)\n`
      : "";
    return {
      text: `${suggestionText}${warn}${key} = ${formatConfigValue(value)}`,
      json: {
        ok: true,
        key,
        value,
        ...(spec
          ? {}
          : { warning: "unknown-key", ...(suggestionKey ? { suggestion: suggestionKey } : {}) }),
      },
      exitCode: 0,
    };
  }

  if (sub === "list") {
    const table = cliProfiles.parseToml(readConfigRaw(file));
    const entries = cliProfiles.effectiveConfig(table);
    const { warnings } = cliProfiles.validateConfig(table);
    if (ctx.json) {
      return {
        json: { ok: true, config: entries, warnings: warnings.map((w) => w.message) },
        exitCode: 0,
      };
    }
    // aligned key / value / source columns (visible-width so a `["x"]` value doesn't misalign).
    const keyW = Math.max(3, ...entries.map((e) => visibleLen(e.key)));
    const valW = Math.max(5, ...entries.map((e) => visibleLen(formatConfigValue(e.value))));
    const lines = [`${padEnd("KEY", keyW)}  ${padEnd("VALUE", valW)}  SOURCE`];
    for (const e of entries) {
      lines.push(
        `${padEnd(e.key, keyW)}  ${padEnd(formatConfigValue(e.value), valW)}  ${e.source}`,
      );
    }
    for (const w of warnings) lines.push(`⚠ ${w.message}`);
    return { text: lines.join("\n"), exitCode: 0 };
  }

  return { text: `prometheus config: unknown action "${sub}"`, json: { ok: false }, exitCode: 2 };
}
