/**
 * terminal.test.ts — profiles + presets + venv resolution + the launcher reducer +
 * persistence (file 13 Area 1).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Env } from "../domain/models.js";
import {
  BUILTIN_AI_PRESETS,
  BUILTIN_SHELL_PROFILES,
  DEFAULT_AI_PRESET_ID,
  DEFAULT_PROFILE_ID,
  type LauncherState,
  PRESET_CLAUDE,
  PRESET_PROM_CHAT,
  type ResolveContext,
  SESSION_RESTORED_BANNER,
  TERMINAL_COMMANDS,
  type TerminalSession,
  activeSession,
  aiLaunchFor,
  broadcastTargets,
  buildProfileMenu,
  envProfiles,
  getTerminalCommand,
  groupFor,
  initialLauncherState,
  isAiPreset,
  launcherReducer,
  presetAvailable,
  resolveProfile,
  resolveVenv,
  restoreSessions,
  sessionsByGroup,
  snapshotSessions,
  spawnArgsFor,
} from "./index.js";
import { PROFILE_PROJECT, PROFILE_SYSTEM } from "./profiles.js";

const ENVS: Env[] = [
  {
    name: "ml",
    path: "/home/u/.venvs/ml",
    kind: "venv",
    pythonVersion: "3.11.8",
    packagesCount: 42,
  },
  { name: "sys", path: "/usr", kind: "system", pythonVersion: "3.12.0", packagesCount: 0 },
];
const CTX: ResolveContext = {
  projectRoot: "/home/u/proj",
  home: "/home/u",
  platform: "posix",
  envs: ENVS,
  activeEnvPath: "/home/u/.venvs/ml",
};

// ---- profiles + presets ---------------------------------------------------- //

test("ships 3 builtin shells + 5 AI presets; prom chat is the default preset", () => {
  assert.equal(BUILTIN_SHELL_PROFILES.length, 3);
  assert.equal(BUILTIN_AI_PRESETS.length, 5);
  assert.equal(DEFAULT_PROFILE_ID, "shell.project");
  assert.equal(DEFAULT_AI_PRESET_ID, PRESET_PROM_CHAT.id);
  assert.ok(isAiPreset(PRESET_PROM_CHAT));
  assert.equal(isAiPreset(PROFILE_PROJECT), false);
});

test("envProfiles generates one profile per non-system Env, activating its venv", () => {
  const profiles = envProfiles(ENVS);
  assert.equal(profiles.length, 1, "system env is skipped");
  assert.equal(profiles[0]?.id, "env.ml");
  assert.equal(profiles[0]?.envRef, "/home/u/.venvs/ml");
  assert.equal(profiles[0]?.managedBy, "env");
});

test("buildProfileMenu lists shells, AI presets, and env profiles", () => {
  const menu = buildProfileMenu(ENVS);
  assert.equal(menu.shells.length, 3);
  assert.equal(menu.aiPresets.length, 5);
  assert.equal(menu.envProfiles.length, 1);
});

// ---- venv-activated resolution (§1.5) -------------------------------------- //

test("spawnArgsFor resolves cwd to project root and no venv for the plain project shell", () => {
  const args = spawnArgsFor(PROFILE_PROJECT, CTX);
  assert.equal(args.cwd, "/home/u/proj");
  assert.equal(args.venv, null, "project shell has no envRef and cwd is projectRoot");
  assert.equal(args.inheritProcessEnv, true);
});

test("an env profile is born activated (venv root + platform resolved)", () => {
  const env = envProfiles(ENVS)[0];
  assert.ok(env);
  const venv = resolveVenv(env as NonNullable<typeof env>, CTX);
  assert.deepEqual(venv, { root: "/home/u/.venvs/ml", platform: "posix" });
});

test("system env never activates a venv", () => {
  const sysProfile = { ...PROFILE_SYSTEM, envRef: "/usr" };
  assert.equal(resolveVenv(sysProfile, CTX), null);
});

test("resolveProfile yields the AI launch command + workspace context for an AI preset", () => {
  const r = resolveProfile(PRESET_PROM_CHAT, CTX);
  assert.equal(r.ai?.command, "prom chat");
  assert.equal(r.ai?.autorun, true);
  assert.equal(r.args.env.PROM_CWD, "/home/u/proj");
});

test("aiLaunchFor appends the model hint when present", () => {
  const withHint = { ...PRESET_PROM_CHAT, modelHint: "--model ollama:qwen3" };
  assert.equal(aiLaunchFor(withHint, CTX).command, "prom chat --model ollama:qwen3");
});

test("presetAvailable: prom always available; vendor CLIs gate on PATH detection", () => {
  assert.equal(presetAvailable(PRESET_PROM_CHAT, new Set()), true);
  assert.equal(presetAvailable(PRESET_CLAUDE, new Set()), false);
  assert.equal(presetAvailable(PRESET_CLAUDE, new Set(["claude"])), true);
});

// ---- §1.8 command catalog -------------------------------------------------- //

test("terminal command catalog carries the headline runPrompt bound to alt+enter", () => {
  const runPrompt = getTerminalCommand("terminal.runPrompt");
  assert.equal(runPrompt?.defaultKeys, "alt+enter");
  assert.equal(runPrompt?.writesToTerminal, true);
  assert.equal(getTerminalCommand("terminal.new")?.defaultKeys, "ctrl+`");
  assert.ok(TERMINAL_COMMANDS.length >= 18);
});

// ---- launcher reducer (§1.2/§1.7) ----------------------------------------- //

function session(
  over: Partial<TerminalSession> & Pick<TerminalSession, "id" | "profileId">,
): TerminalSession {
  return { title: over.id, status: "running", openAs: "tab", group: "project", ...over };
}

test("open/focus/close maintains a sane active session", () => {
  let s: LauncherState = initialLauncherState();
  s = launcherReducer(s, {
    type: "open",
    session: session({ id: "1", profileId: "shell.project" }),
  });
  s = launcherReducer(s, {
    type: "open",
    session: session({ id: "2", profileId: "shell.system" }),
  });
  assert.equal(s.activeId, "2");
  s = launcherReducer(s, { type: "close", id: "2" });
  assert.equal(s.activeId, "1", "active falls back to a surviving session");
  // idempotent open returns to focus, no dup
  s = launcherReducer(s, {
    type: "open",
    session: session({ id: "1", profileId: "shell.project" }),
  });
  assert.equal(s.sessions.length, 1);
});

test("next/prev cycles the active session", () => {
  let s: LauncherState = initialLauncherState();
  for (const id of ["1", "2", "3"]) {
    s = launcherReducer(s, { type: "open", session: session({ id, profileId: "p" }) });
  }
  s = launcherReducer(s, { type: "focus", id: "1" });
  s = launcherReducer(s, { type: "prev" });
  assert.equal(s.activeId, "3", "prev wraps to the last");
  s = launcherReducer(s, { type: "next" });
  assert.equal(s.activeId, "1");
});

test("groupFor + sessionsByGroup split project / ai / floating", () => {
  assert.equal(groupFor(PROFILE_PROJECT, "tab"), "project");
  assert.equal(groupFor(PRESET_PROM_CHAT, "tab"), "ai");
  assert.equal(groupFor(PROFILE_PROJECT, "float"), "floating");
  let s = initialLauncherState();
  s = launcherReducer(s, {
    type: "open",
    session: session({ id: "a", profileId: "p", group: "project" }),
  });
  s = launcherReducer(s, {
    type: "open",
    session: session({ id: "b", profileId: "ai", group: "ai" }),
  });
  assert.deepEqual(
    sessionsByGroup(s).map((g) => g.group),
    ["project", "ai"],
  );
});

test("broadcast mirrors keystrokes to the rest of the active group only", () => {
  let s = initialLauncherState();
  s = launcherReducer(s, {
    type: "open",
    session: session({ id: "a", profileId: "p", group: "project" }),
  });
  s = launcherReducer(s, {
    type: "open",
    session: session({ id: "b", profileId: "p", group: "project" }),
  });
  s = launcherReducer(s, {
    type: "open",
    session: session({ id: "c", profileId: "ai", group: "ai" }),
  });
  assert.deepEqual(broadcastTargets(s, "a"), [], "broadcast off → no mirroring");
  s = launcherReducer(s, { type: "set-broadcast", on: true });
  assert.deepEqual(
    broadcastTargets(s, "a"),
    ["b"],
    "only the same-group sibling, not the AI session",
  );
  assert.ok(activeSession(s));
});

// ---- persistence (§1.7) — session, not process ---------------------------- //

test("snapshot persists only persist:true sessions; restore is honest (idle + restored)", () => {
  let s = initialLauncherState();
  s = launcherReducer(s, {
    type: "open",
    session: session({ id: "1", profileId: "shell.project", persist: true, cwd: "/p" }),
  });
  s = launcherReducer(s, {
    type: "open",
    session: session({ id: "2", profileId: "ad-hoc", persist: false }),
  });
  const snaps = snapshotSessions(s, (id) => `tail-${id}`);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0]?.scrollbackTail, "tail-1");
  const restored = restoreSessions(snaps, (_snap, i) => `r${i}`);
  assert.equal(restored[0]?.status, "idle");
  assert.equal(restored[0]?.restored, true);
  assert.equal(restored[0]?.profileId, "shell.project");
  assert.match(SESSION_RESTORED_BANNER, /session restored/);
});
