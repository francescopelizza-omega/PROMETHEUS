/**
 * terminal — the in-IDE terminal launcher UX model (file 13 Area 1). Pure: profiles +
 * AI presets (§1.3/§1.4), venv-activated spawn-arg resolution (§1.5), the session-list
 * reducer + broadcast + "session, not process" persistence (§1.2/§1.7), and the §1.8
 * command catalog. Spawning is 07's pty-host; this never spawns.
 */
export type {
  AiCli,
  AiTerminalPreset,
  CwdSpec,
  ProfileMenu,
  ProfileScope,
  TerminalProfile,
} from "./profiles.js";
export {
  BUILTIN_AI_PRESETS,
  BUILTIN_SHELL_PROFILES,
  DEFAULT_AI_PRESET_ID,
  DEFAULT_PROFILE_ID,
  PRESET_CLAUDE,
  PRESET_CODEX,
  PRESET_GEMINI,
  PRESET_PROM,
  PRESET_PROM_CHAT,
  PROFILE_BASH_LOGIN,
  PROFILE_PROJECT,
  PROFILE_SYSTEM,
  buildProfileMenu,
  customAiPreset,
  envProfiles,
  isAiPreset,
} from "./profiles.js";
export type {
  AiLaunch,
  ResolveContext,
  ResolvedSpawn,
  ResolvedVenv,
  TerminalPlatform,
  TerminalSpawnArgs,
} from "./resolve.js";
export {
  aiLaunchFor,
  presetAvailable,
  resolveCwd,
  resolveProfile,
  resolveVenv,
  spawnArgsFor,
} from "./resolve.js";
export type {
  LauncherEvent,
  LauncherState,
  OpenTarget,
  SessionGroup,
  TerminalSession,
  TerminalSnapshot,
  TerminalStatus,
} from "./launcher.js";
export {
  SESSION_RESTORED_BANNER,
  activeSession,
  broadcastTargets,
  groupFor,
  initialLauncherState,
  launcherReducer,
  restoreSessions,
  sessionsByGroup,
  snapshotSessions,
} from "./launcher.js";
export type { IdeCommand } from "./commands.js";
export { READ_TO_RUN_FLOWS, TERMINAL_COMMANDS, getTerminalCommand } from "./commands.js";
