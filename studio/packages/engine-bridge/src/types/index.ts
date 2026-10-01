// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/index.ts — the discriminated `Envelope` union + the narrowing helper
 * (file 02 §3.3). One re-export barrel for every per-command typed envelope.
 *
 * The union is discriminated on the `command` string-literal each per-command
 * envelope pins. A bare `EnvelopeBase` (the generic from contract.ts) is the
 * FALLTHROUGH arm so not-yet-typed engine commands (models/apps/worldsim/localai/
 * pentest/enable/disable/etc.) still parse untyped — the bridge never REQUIRES a
 * typed payload to function (file 02 §3.3 note on coverage).
 *
 * isCommand(env, name) narrows a parsed Envelope to the specific arm by its
 * `command` literal, so callers branch type-safely without a manual cast.
 */
import type { EnvelopeBase } from "./envelope.js";

import type { AuditEnvelope } from "./audit.js";
import type { DescribeEnvelope } from "./describe.js";
import type { DoctorEnvelope } from "./doctor.js";
import type { HardenEnvelope } from "./harden.js";
import type { InfoEnvelope } from "./info.js";
import type { InstallEnvelope } from "./install.js";
import type { ListEnvelope } from "./list.js";
import type { MatrixEnvelope } from "./matrix.js";
import type { MethodsEnvelope } from "./methods.js";
import type { ScanEnvelope } from "./scan.js";
import type { SkillsEnvelope } from "./skills.js";
import type { StatusEnvelope } from "./status.js";
import type { SuperscanEnvelope } from "./superscan.js";
import type { TutorialEnvelope } from "./tutorial.js";
import type { VaultEnvelope } from "./vault.js";
import type { WhereEnvelope } from "./where.js";

// --- re-export every per-command envelope + payload type -------------------- //
export type { EnvelopeBase, LooseEnvelope } from "./envelope.js";
export type { ScanEnvelope, ScanOs, ScanAgent } from "./scan.js";
export type {
  SuperscanEnvelope,
  SuperscanAgent,
  SuperscanCounts,
} from "./superscan.js";
export type {
  ListEnvelope,
  CatalogEntry,
  CatalogTarget,
  CatalogTier,
  CatalogScope,
} from "./list.js";
export type {
  InstallEnvelope,
  InstallEvent,
  InstallResult,
  InstallResults,
  InstallScope,
  InstallSummary,
  InstallRequestEcho,
} from "./install.js";
export type {
  AuditEnvelope,
  AuditEntry,
  AuditScanReport,
  AuditFinding,
  AuditNemesisVerdict,
} from "./audit.js";
export type {
  InfoEnvelope,
  InfoPlugin,
  InfoTarget,
  InfoComponent,
} from "./info.js";
export type { WhereEnvelope, WherePlugin, WhereTarget } from "./where.js";
export type {
  StatusEnvelope,
  StatusPlugin,
  StatusAgent,
  StatusComponent,
} from "./status.js";
export type { MatrixEnvelope, MatrixReach } from "./matrix.js";
export type { SkillsEnvelope, SkillEntry } from "./skills.js";
export type { VaultEnvelope, VaultRepo } from "./vault.js";
export type { DoctorEnvelope, DoctorReport } from "./doctor.js";
// catalog cards + defensive audit (typed arms of the union)
export type { DescribeEnvelope } from "./describe.js";
export type { TutorialEnvelope } from "./tutorial.js";
export type { MethodsEnvelope } from "./methods.js";
export type { HardenEnvelope, HardenFinding } from "./harden.js";
// chat + models config/browse — typed but NOT in the union (shared command literal)
export type { ChatLocalEnvelope, ChatTerminalEnvelope } from "./chat.js";
export type { ModelsConfigEnvelope, ModelsBrowseEnvelope, OpenModelRow } from "./models.js";

// --- request builders ------------------------------------------------------- //
export type {
  InstallRequest,
  UninstallRequest,
  ToggleComponent,
} from "./request.js";

/**
 * The full discriminated union the bridge can return. `EnvelopeBase` is the
 * untyped fallthrough for commands not yet given a typed payload.
 */
export type Envelope =
  | ScanEnvelope
  | SuperscanEnvelope
  | ListEnvelope
  | InstallEnvelope
  | AuditEnvelope
  | InfoEnvelope
  | WhereEnvelope
  | StatusEnvelope
  | MatrixEnvelope
  | SkillsEnvelope
  | VaultEnvelope
  | DoctorEnvelope
  | DescribeEnvelope
  | TutorialEnvelope
  | MethodsEnvelope
  | HardenEnvelope
  | EnvelopeBase; // fallthrough — keep LAST so the literal arms win narrowing.

/**
 * Map a `command` literal to its envelope type. Lets isCommand() return the
 * precisely-narrowed arm rather than a broad union member.
 */
export interface EnvelopeByCommand {
  scan: ScanEnvelope;
  superscan: SuperscanEnvelope;
  list: ListEnvelope;
  install: InstallEnvelope;
  uninstall: InstallEnvelope;
  audit: AuditEnvelope;
  info: InfoEnvelope;
  where: WhereEnvelope;
  status: StatusEnvelope;
  matrix: MatrixEnvelope;
  skills: SkillsEnvelope;
  vault: VaultEnvelope;
  doctor: DoctorEnvelope;
  describe: DescribeEnvelope;
  tutorial: TutorialEnvelope;
  methods: MethodsEnvelope;
  harden: HardenEnvelope;
}

/** Every command name that has a typed envelope arm. */
export type KnownCommand = keyof EnvelopeByCommand;

/**
 * isCommand(env, name) — NARROWING helper (file 02 §3.3). Returns true and
 * narrows `env` to the typed arm for `name` when `env.command === name`.
 *
 * Note both install & uninstall narrow to InstallEnvelope (they share the wire
 * shape); the runtime check is still the exact `command` string.
 */
export function isCommand<K extends KnownCommand>(
  env: Pick<EnvelopeBase, "command">,
  name: K,
): env is EnvelopeByCommand[K] {
  return env.command === name;
}
