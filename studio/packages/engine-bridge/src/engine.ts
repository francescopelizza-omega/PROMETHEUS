import { type EngineClient, createEngineClient } from "./client.js";
/**
 * engine.ts — PrometheusEngine, the typed command FACADE (file 02 §3.4).
 *
 * One method per command, each returning the precisely-typed envelope from
 * src/types/ over a PythonSidecar. Callers never touch argv: they pass typed
 * requests and get typed envelopes back. The facade also owns the InstallRequest
 * argv builder (global flags BEFORE the subcommand, hosts -> --host) so the
 * request type in src/types/request.ts has exactly one place that lowers it.
 *
 * REUSE, DON'T REPLACE: the existing createEngineClient (client.ts) is the
 * lower-level SHARED_API and stays unchanged. PrometheusEngine WRAPS a
 * PythonSidecar (which itself wraps run.ts), and exposes `asClient()` so a caller
 * that wants the established EngineClient surface still gets one over the SAME
 * engine config — no breakage, no second spawner (C5).
 *
 * Op CLASSES (sidecar timeouts + serialization, file 02 §4.2/§4.4):
 *   read-only inventory  -> op "readonly" (60s)
 *   audit/scan/superscan -> op "scan"     (120s)
 *   install/uninstall    -> op "mutation" (600s, SERIALIZED)
 *   enable/disable       -> op "mutation" (serialized: they mutate config too)
 */
import { type ChatPreviewOpts, Commands, notFlag } from "./commands.js";
import type { EngineConfig } from "./config.js";
import type { RunOptions } from "./run.js";
import { type ExecOptions, PythonSidecar, type SidecarHealth } from "./sidecar.js";

import type {
  AuditEnvelope,
  ChatLocalEnvelope,
  ChatTerminalEnvelope,
  DescribeEnvelope,
  EnvelopeBase,
  HardenEnvelope,
  InfoEnvelope,
  InstallEnvelope,
  InstallRequest,
  ListEnvelope,
  MatrixEnvelope,
  MethodsEnvelope,
  ModelsBrowseEnvelope,
  ModelsConfigEnvelope,
  ScanEnvelope,
  SkillsEnvelope,
  StatusEnvelope,
  SuperscanEnvelope,
  ToggleComponent,
  TutorialEnvelope,
  UninstallRequest,
  VaultEnvelope,
  WhereEnvelope,
} from "./types/index.js";

/** Per-call overrides a facade method accepts (streaming/cancel/timeout). */
export type CallOptions = RunOptions;

/**
 * Build the install argv from an InstallRequest. GLOBAL FLAGS FIRST, then the
 * subcommand, then sub-flags — identical ordering to commands.ts/tools.ts.
 * `dryRun` defaults TRUE (preview first) when omitted.
 */
export function buildInstallArgv(r: InstallRequest): string[] {
  const dryRun = r.dryRun ?? true;
  return [
    ...(dryRun ? ["--dry-run"] : []),
    ...(r.yes ? ["--yes"] : []),
    ...(r.strict ? ["--strict"] : []),
    ...(r.force ? ["--force"] : []),
    "install",
    notFlag(r.name, "name"),
    ...(r.only ? ["--only", notFlag(r.only, "--only")] : []),
    ...(r.hosts ?? []).flatMap((h) => ["--host", notFlag(h, "--host")]),
  ];
}

/** Build the uninstall argv from an UninstallRequest (no force/strict path). */
export function buildUninstallArgv(r: UninstallRequest): string[] {
  const dryRun = r.dryRun ?? true;
  return [
    ...(dryRun ? ["--dry-run"] : []),
    ...(r.yes ? ["--yes"] : []),
    "uninstall",
    notFlag(r.name, "name"),
    ...(r.only ? ["--only", notFlag(r.only, "--only")] : []),
    ...(r.hosts ?? []).flatMap((h) => ["--host", notFlag(h, "--host")]),
  ];
}

/**
 * PrometheusEngine — the typed facade over a PythonSidecar.
 *
 * Construct from an EngineConfig (it makes its own sidecar) or pass an existing
 * PythonSidecar to share its in-flight tracking / mutation queue (e.g. the
 * desktop main process keeps ONE sidecar for the app lifetime).
 */
export class PrometheusEngine {
  readonly sidecar: PythonSidecar;
  private readonly config: EngineConfig;

  constructor(arg: EngineConfig | PythonSidecar = {}) {
    if (arg instanceof PythonSidecar) {
      this.sidecar = arg;
      this.config = {};
    } else {
      this.config = arg;
      this.sidecar = new PythonSidecar(arg);
    }
  }

  // --- read-only inventory / query (op: readonly, 60s) -------------------- //

  scan(o?: CallOptions): Promise<ScanEnvelope> {
    return this.sidecar.exec<ScanEnvelope>(Commands.scan(), { ...o, op: "readonly" });
  }

  list(o?: CallOptions): Promise<ListEnvelope> {
    return this.sidecar.exec<ListEnvelope>(Commands.list(), { ...o, op: "readonly" });
  }

  matrix(o?: CallOptions): Promise<MatrixEnvelope> {
    return this.sidecar.exec<MatrixEnvelope>(Commands.matrix(), { ...o, op: "readonly" });
  }

  info(name: string, o?: CallOptions): Promise<InfoEnvelope> {
    return this.sidecar.exec<InfoEnvelope>(Commands.info(name), { ...o, op: "readonly" });
  }

  where(name: string, o?: CallOptions): Promise<WhereEnvelope> {
    return this.sidecar.exec<WhereEnvelope>(Commands.where(name), { ...o, op: "readonly" });
  }

  /** `status <name>` or `status all`. */
  status(name: string, o?: CallOptions): Promise<StatusEnvelope> {
    return this.sidecar.exec<StatusEnvelope>(Commands.status(name), { ...o, op: "readonly" });
  }

  skillsList(o?: CallOptions): Promise<SkillsEnvelope> {
    return this.sidecar.exec<SkillsEnvelope>(["skills", "list"], { ...o, op: "readonly" });
  }

  vault(o?: CallOptions): Promise<VaultEnvelope> {
    return this.sidecar.exec<VaultEnvelope>(Commands.vaultStatus(), { ...o, op: "readonly" });
  }

  // --- catalog cards: describe / tutorial / methods (op: readonly) -------- //

  /** Rich card for any catalog id (what / security / install + remove). */
  describe(id: string, o?: CallOptions): Promise<DescribeEnvelope> {
    return this.sidecar.exec<DescribeEnvelope>(Commands.describe(id), { ...o, op: "readonly" });
  }

  /** Deep tutorial (dossier markdown) — the GUI "Learn more" drawer. */
  tutorial(id: string, o?: CallOptions): Promise<TutorialEnvelope> {
    return this.sidecar.exec<TutorialEnvelope>(Commands.tutorial(id), { ...o, op: "readonly" });
  }

  /** Every documented install method for an id (markdown section). */
  methods(id: string, o?: CallOptions): Promise<MethodsEnvelope> {
    return this.sidecar.exec<MethodsEnvelope>(Commands.methods(id), { ...o, op: "readonly" });
  }

  // --- local models: config + browse (op: readonly) ----------------------- //

  /** Show or set the default models install folder (models_root). */
  modelsConfig(setRoot?: string, o?: CallOptions): Promise<ModelsConfigEnvelope> {
    return this.sidecar.exec<ModelsConfigEnvelope>(Commands.modelsConfig(setRoot), {
      ...o,
      op: "readonly",
    });
  }

  /** Open models that can run locally (ollama tags) — the model picker. */
  modelsBrowse(o?: CallOptions): Promise<ModelsBrowseEnvelope> {
    return this.sidecar.exec<ModelsBrowseEnvelope>(Commands.modelsBrowse(), {
      ...o,
      op: "readonly",
    });
  }

  // --- chat: agentic local + terminal preview ----------------------------- //

  /** Agentic local chat (one-shot) against ollama/lmstudio (op: scan — may be slow). */
  chatLocal(
    model: string,
    prompt: string,
    runner?: string,
    o?: CallOptions,
  ): Promise<ChatLocalEnvelope> {
    return this.sidecar.exec<ChatLocalEnvelope>(Commands.chatLocal(model, prompt, runner), {
      ...o,
      op: "scan",
    });
  }

  /**
   * Terminal-chat PREVIEW: returns the assembled (injection-safe) argv + env +
   * notes the GUI shows before the user clicks OPEN. NEVER launches (no --open);
   * the actual terminal is spawned by the desktop pty-host, not the engine.
   */
  chatPreview(cli: string, opts?: ChatPreviewOpts, o?: CallOptions): Promise<ChatTerminalEnvelope> {
    return this.sidecar.exec<ChatTerminalEnvelope>(Commands.chatPreview(cli, opts), {
      ...o,
      op: "readonly",
    });
  }

  // --- heavier read-only ops (op: scan, 120s) ----------------------------- //

  superscan(o?: CallOptions): Promise<SuperscanEnvelope> {
    return this.sidecar.exec<SuperscanEnvelope>(Commands.superscan(), { ...o, op: "scan" });
  }

  /** Security audit a plugin (or 'all') — NAME only, never a --target (C4). */
  audit(name: string, o?: CallOptions): Promise<AuditEnvelope> {
    return this.sidecar.exec<AuditEnvelope>(Commands.audit(name), { ...o, op: "scan" });
  }

  /** Defensive self-audit of THIS machine (firewall/ports/ssh/encryption/secrets). */
  harden(o?: CallOptions): Promise<HardenEnvelope> {
    return this.sidecar.exec<HardenEnvelope>(Commands.harden(), { ...o, op: "scan" });
  }

  // --- state-changing ops (op: mutation, 600s, SERIALIZED) ---------------- //

  /**
   * Install a plugin. Forwards to the engine, which runs nemesis ITSELF and
   * returns a `blocked` event (or a forced_danger/ok:false envelope under
   * --force). JS decides NOTHING here (C5 GOLDEN RULE). dryRun defaults true.
   */
  install(req: InstallRequest, o?: CallOptions): Promise<InstallEnvelope> {
    const exec: ExecOptions = { ...o, op: "mutation", forced: req.force ?? false };
    return this.sidecar.exec<InstallEnvelope>(buildInstallArgv(req), exec);
  }

  uninstall(req: UninstallRequest, o?: CallOptions): Promise<InstallEnvelope> {
    return this.sidecar.exec<InstallEnvelope>(buildUninstallArgv(req), { ...o, op: "mutation" });
  }

  enable(name: string, component?: ToggleComponent, o?: CallOptions): Promise<EnvelopeBase> {
    return this.sidecar.exec<EnvelopeBase>(Commands.enable(name, { component }), {
      ...o,
      op: "mutation",
    });
  }

  disable(name: string, component?: ToggleComponent, o?: CallOptions): Promise<EnvelopeBase> {
    return this.sidecar.exec<EnvelopeBase>(Commands.disable(name, { component }), {
      ...o,
      op: "mutation",
    });
  }

  // --- lifecycle ----------------------------------------------------------- //

  /** Resolve + read-only contract probe for the status pill (file 02 §4.2). */
  health(o?: { timeoutMs?: number }): Promise<SidecarHealth> {
    return this.sidecar.health(o);
  }

  /** Abort every in-flight op (app-quit). Delegates to the sidecar. */
  cancelAll(): void {
    this.sidecar.cancelAll();
  }

  /**
   * asClient() — the established EngineClient surface (client.ts) over the SAME
   * EngineConfig, so existing createEngineClient callers keep working and a
   * PrometheusEngine user can drop down to the lower-level API when needed. No
   * second spawner: both ultimately route through run.ts.
   */
  asClient(): EngineClient {
    return createEngineClient(this.config);
  }
}

/**
 * createPrometheusEngine(config) — convenience factory mirroring
 * createEngineClient's ergonomics for the facade.
 */
export function createPrometheusEngine(config: EngineConfig = {}): PrometheusEngine {
  return new PrometheusEngine(config);
}
