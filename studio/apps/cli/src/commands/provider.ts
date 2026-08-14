/**
 * commands/provider.ts — `prometheus provider list`: render the C11 provider
 * promotion policy from @prometheus/core. Sorted Tier-A-first; a green cost
 * light + "Recommended (free, local)" badge on Tier A; a red metered warning on
 * Tier C. The CLI reads the policy from core — it does not re-decide tiers.
 */
import {
  type CostLight,
  type Provider,
  type SecretsStore,
  ai,
  classifyTier,
  costLight,
  loadProviders,
  needsCostWarning,
  orchestration,
  requiredConfirmPhrase,
  secrets,
  sortByPromotion,
} from "@prometheus/core";

import type { CliContext, CommandOutcome } from "../context.js";
import { prometheusHome } from "../home.js";
import {
  ENABLE_METERED_PHRASE,
  grantMeteredConsent,
  hasMeteredConsent,
  isEnableMeteredPhrase,
} from "../metered-consent.js";
import { c, heading, kv, table } from "../render.js";
import { createCliSecretsStore } from "../secrets-backend.js";
import { promptYesNo } from "./sidecar-cmd.js";

function lightDot(light: CostLight): string {
  switch (light) {
    case "green":
      return c.green("●");
    case "blue":
      return c.blue("●");
    case "red":
      return c.red("●");
  }
}

function tierCell(tier: "A" | "B" | "C"): string {
  switch (tier) {
    case "A":
      return c.green("A");
    case "B":
      return c.blue("B");
    case "C":
      return c.red("C");
  }
}

export async function runProviderList(ctx: CliContext): Promise<CommandOutcome> {
  let providers: Provider[];
  try {
    providers = await loadProviders();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: c.red(`provider config unavailable: ${msg}`),
      json: { ok: false, error: msg },
      exitCode: 2,
    };
  }

  const sorted = sortByPromotion(providers);

  if (ctx.json) {
    const payload = sorted.map((p) => ({
      id: p.id,
      label: p.label,
      tier: classifyTier(p),
      costLight: costLight(p),
      billingMode: p.billingMode,
      metered: needsCostWarning(p),
      requiresTypedConfirm: requiredConfirmPhrase(p) ?? null,
      isEscapeHatch: p.isEscapeHatch === true,
    }));
    return { json: { ok: true, providers: payload }, exitCode: 0 };
  }

  const rows = sorted.map((p) => {
    const tier = classifyTier(p);
    const badge =
      tier === "A"
        ? c.green("Recommended (free, local)")
        : needsCostWarning(p)
          ? c.red("METERED — per-token cost")
          : tier === "B"
            ? c.blue("Covered by subscription")
            : "";
    return [lightDot(costLight(p)), tierCell(tier), p.label, c.dim(p.billingMode), badge];
  });

  const lines: string[] = [];
  lines.push(heading(`Providers  ${c.dim(`(${sorted.length}, Tier-A first)`)}`));
  lines.push("");
  lines.push(
    table(
      [
        { header: "" },
        { header: "TIER" },
        { header: "PROVIDER" },
        { header: "BILLING" },
        { header: "NOTE" },
      ],
      rows,
    ),
  );
  lines.push("");
  lines.push(
    c.dim(
      "Tier A local/free is default. Tier C is never auto-enabled — it needs a typed confirm + cost guardrail.",
    ),
  );

  return { text: lines.join("\n"), exitCode: 0 };
}

/**
 * `prometheus provider show <id>` — the full C11 policy record for one provider (the GUI
 * ProviderPicker detail). Pure read over providers.config.json; `--json` dumps the
 * Provider. Mirrors the list's tier/cost-light semantics for a single row.
 */
export async function runProviderShow(ctx: CliContext): Promise<CommandOutcome> {
  const id = ctx.args.positionals[0];
  if (!id) {
    return {
      text: c.red("usage: prometheus provider show <id>"),
      json: { ok: false, error: "missing-id" },
      exitCode: 2,
    };
  }
  let providers: Provider[];
  try {
    providers = await loadProviders();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: c.red(`provider config unavailable: ${msg}`),
      json: { ok: false, error: msg },
      exitCode: 2,
    };
  }
  const p = providers.find((x) => x.id === id || x.aliases?.includes(id));
  if (!p) {
    return {
      text: c.red(`provider '${id}' not found. List with: prometheus provider list`),
      json: { ok: false, error: "not-found", id },
      exitCode: 2,
    };
  }
  const tier = classifyTier(p);
  if (ctx.json) {
    return {
      json: {
        ok: true,
        provider: {
          id: p.id,
          label: p.label,
          aliases: p.aliases ?? [],
          tier,
          costLight: costLight(p),
          billingMode: p.billingMode,
          metered: needsCostWarning(p),
          requiresTypedConfirm: requiredConfirmPhrase(p) ?? null,
          isEscapeHatch: p.isEscapeHatch === true,
        },
      },
      exitCode: 0,
    };
  }
  const lines = [heading(`${p.label}  ${tierCell(tier)}`), ""];
  lines.push(kv("id", c.dim(p.id)));
  if (p.aliases?.length) lines.push(kv("aliases", c.dim(p.aliases.join(", "))));
  lines.push(kv("cost", `${lightDot(costLight(p))} ${c.dim(p.billingMode)}`));
  lines.push(kv("tier", tierCell(tier)));
  if (needsCostWarning(p)) {
    lines.push(kv("metered", c.red("yes — per-token cost")));
    const phrase = requiredConfirmPhrase(p);
    if (phrase) lines.push(kv("enable confirm", c.yellow(`type "${phrase}"`)));
  }
  if (p.isEscapeHatch)
    lines.push(kv("note", c.dim("local escape-hatch (engine localai re-point)")));
  return { text: lines.join("\n"), exitCode: 0 };
}

/* ── connect / status / disconnect: keychain-backed API keys (CLI-028) ───────── */

/** The minimal fetch surface the verify-ping needs (injectable in tests). */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** IO seams so the whole surface is tested with InMemorySecretsStore + a fake fetch. */
export interface ProviderIoDeps {
  secrets: SecretsStore;
  fetch: FetchLike;
  /** masked key read (TTY echo off, or one stdin line non-interactively). */
  readKey: () => Promise<string>;
  /** disconnect consent (default = a TTY y/N prompt). */
  confirm: () => Promise<boolean>;
  env: Record<string, string | undefined>;
}

const globalFetch: FetchLike = (url, init) => (globalThis.fetch as unknown as FetchLike)(url, init);

/** Read an API key with the terminal echo OFF (masked), or one stdin line when non-TTY. */
function maskedReadKey(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    // non-TTY: read one line, never echo it back.
    return new Promise((resolve) => {
      let buf = "";
      const onData = (b: Buffer): void => {
        buf += b.toString();
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          stdin.off("data", onData);
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ""));
        }
      };
      const onEnd = (): void => {
        stdin.off("data", onData);
        resolve(buf.replace(/\r?\n?$/, ""));
      };
      stdin.resume();
      stdin.on("data", onData);
      stdin.once("end", onEnd);
    });
  }
  process.stderr.write("API key (hidden): ");
  return new Promise((resolve) => {
    let key = "";
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (): void => {
      stdin.setRawMode(false); // ALWAYS restore cooked mode
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      resolve(key);
    };
    const onData = (b: Buffer): void => {
      for (const ch of b) {
        if (ch === 0x0d || ch === 0x0a) {
          finish(); // Enter
          return;
        }
        if (ch === 0x03) {
          key = ""; // Ctrl-C → abort with empty
          finish();
          return;
        }
        if (ch === 0x7f || ch === 0x08) {
          key = key.slice(0, -1); // Backspace
          continue;
        }
        key += String.fromCharCode(ch);
        process.stderr.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

const defaultProviderIo = (): ProviderIoDeps => ({
  secrets: createCliSecretsStore(),
  fetch: globalFetch,
  readKey: maskedReadKey,
  confirm: () => promptYesNo("disconnect this provider?"),
  env: process.env,
});

const providerAccount = (id: string): string => `provider:${id}`;

interface PingResult {
  ok: boolean;
  status: number;
  modelCount?: number;
  errorBody?: string;
}

/**
 * Verify a key against the provider's model-list path (auth-checked, bills ZERO tokens).
 *
 * Both halves of this request used to be OpenAI's and only OpenAI's: the path `/models` and
 * an `Authorization: Bearer` header. Anthropic serves `/v1/models` and authenticates with
 * `x-api-key` plus a mandatory `anthropic-version`; Gemini serves `/v1beta/models` and takes
 * `x-goog-api-key`. So the ping 404'd for both, `connect` read that as an invalid key and
 * refused to store it — a correct Anthropic or Gemini key could not be saved at all, and
 * `--keep-unverified` still exited non-zero.
 *
 * The path comes from the registry and the headers from `ai/wire.ts`, which is the same
 * module the transports use — so a provider can never be verified one way and called another.
 *
 * Time-boxed (8s) so a wrong base URL can't hang. On failure the response body is redacted
 * (a gateway may echo the credential back) before it is surfaced.
 */
async function verifyPing(
  provider: orchestration.ApiProvider,
  key: string,
  doFetch: FetchLike,
): Promise<PingResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const base = provider.baseUrl.replace(/\/$/, "");
    const wire = ai.selectWire(ai.runtimeFromBaseUrl(provider.baseUrl, "cloud"));
    const res = await doFetch(`${base}${provider.verifyPath ?? "/models"}`, {
      headers: { ...wire.headers(key), Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = secrets.redactSecretEnv(await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, status: res.status, errorBody: body || `HTTP ${res.status}` };
    }
    let modelCount: number | undefined;
    try {
      const data = (await res.json()) as { data?: unknown };
      if (Array.isArray(data?.data)) modelCount = data.data.length;
    } catch {
      /* a reachable endpoint that doesn't list models leaves modelCount undefined */
    }
    return { ok: true, status: res.status, ...(modelCount !== undefined ? { modelCount } : {}) };
  } catch (e) {
    return { ok: false, status: 0, errorBody: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** `prometheus provider connect <id>` — store the key in the keychain + verify at setup. */
export async function runProviderConnect(
  ctx: CliContext,
  io: ProviderIoDeps = defaultProviderIo(),
): Promise<CommandOutcome> {
  const id = ctx.args.positionals[0];
  if (!id) {
    return {
      text: c.red("usage: prometheus provider connect <id>"),
      json: { ok: false, error: "missing-id" },
      exitCode: 2,
    };
  }
  const p = orchestration.apiProviderFor(id);
  if (!p) {
    return {
      text: c.red(`'${id}' is not a known API provider. List with: prometheus provider status`),
      json: { ok: false, error: "not-found", id },
      exitCode: 2,
    };
  }
  const key = (await io.readKey()).trim();
  if (!key) {
    return {
      text: c.red("no API key entered — nothing stored."),
      json: { ok: false, error: "empty-key" },
      exitCode: 2,
    };
  }
  const account = providerAccount(p.id);
  // Verify BEFORE writing the keychain: a failed verify (typo/unreachable) must NOT overwrite an
  // existing valid key. Store only once verified, or explicitly with --keep-unverified.
  const ping = await verifyPing(p, key, io.fetch);
  const keep = ctx.args.flags["keep-unverified"] !== undefined;
  if (!ping.ok && !keep) {
    return {
      text: c.red(
        `verify failed for ${p.label} (HTTP ${ping.status}): ${ping.errorBody ?? "unreachable"}\n  ${c.dim("key NOT stored (any existing key kept) — re-run without a typo, or --keep-unverified")}`,
      ),
      json: { ok: false, error: "verify-failed", id: p.id, status: ping.status, kept: false },
      exitCode: 2,
    };
  }
  try {
    await io.secrets.set(secrets.SECRETS_SERVICE, account, key);
  } catch (e) {
    return {
      text: c.red(`keychain error: ${(e as Error).message}`),
      json: { ok: false, error: "keychain" },
      exitCode: 2,
    };
  }
  if (!ping.ok) {
    // stored under --keep-unverified but the ping failed — report it honestly (exit 2).
    return {
      text: c.red(
        `verify failed for ${p.label} (HTTP ${ping.status}): ${ping.errorBody ?? "unreachable"}\n  ${c.dim("key kept (--keep-unverified)")}`,
      ),
      json: { ok: false, error: "verify-failed", id: p.id, status: ping.status, kept: true },
      exitCode: 2,
    };
  }
  const warn =
    p.confidence === "verify"
      ? `\n  ${c.yellow("confirm the exact OpenAI-compatible endpoint/terms")} ${c.dim(p.tosUrl)}`
      : "";
  const models = typeof ping.modelCount === "number" ? ` · ${ping.modelCount} models` : "";
  return {
    text: `${c.green("✓")} connected ${c.bold(p.label)}${c.dim(models)} ${c.dim("(key in OS keychain, never a file)")}${warn}`,
    json: { ok: true, id: p.id, verified: true, modelCount: ping.modelCount ?? null },
    exitCode: 0,
  };
}

/** `prometheus provider status [--json]` — configured/reachable/modelCount for all 16 providers. */
export async function runProviderStatus(
  ctx: CliContext,
  io: ProviderIoDeps = defaultProviderIo(),
): Promise<CommandOutcome> {
  const rows: {
    id: string;
    label: string;
    configured: boolean;
    source: string | null;
    reachable: boolean | null;
    modelCount: number | null;
  }[] = [];
  for (const id of orchestration.API_PROVIDER_IDS) {
    const p = orchestration.apiProviderFor(id);
    if (!p) continue;
    let key: string | undefined;
    let source: string | null = null;
    try {
      key = await io.secrets.get(secrets.SECRETS_SERVICE, providerAccount(id));
    } catch {
      key = undefined;
    }
    if (key) source = "keychain";
    else {
      const r = orchestration.resolveApiKey(id, io.env); // env still resolves (explicit override)
      if (r) {
        key = r.key;
        source = `env:${r.env}`;
      }
    }
    const configured = Boolean(key);
    let reachable: boolean | null = null;
    let modelCount: number | null = null;
    if (configured && key) {
      const ping = await verifyPing(p, key, io.fetch);
      reachable = ping.ok;
      modelCount = typeof ping.modelCount === "number" ? ping.modelCount : null;
    }
    rows.push({ id, label: p.label, configured, source, reachable, modelCount });
  }
  if (ctx.json) return { json: { ok: true, providers: rows }, exitCode: 0 };

  const dot = (r: boolean | null): string =>
    r === null ? c.dim("-") : r ? c.green("●") : c.red("●");
  const tableRows = rows.map((r) => [
    r.label,
    r.configured ? c.green("yes") : c.dim("no"),
    r.source ?? c.dim("-"),
    dot(r.reachable),
    r.modelCount === null ? c.dim("-") : String(r.modelCount),
  ]);
  const lines = [heading(`Provider status  ${c.dim(`(${rows.length})`)}`), ""];
  lines.push(
    table(
      [
        { header: "PROVIDER" },
        { header: "CONFIGURED" },
        { header: "SOURCE" },
        { header: "REACHABLE" },
        { header: "MODELS" },
      ],
      tableRows,
    ),
  );
  return { text: lines.join("\n"), exitCode: 0 };
}

/** `prometheus provider disconnect <id>` — confirm then delete the keychain key. */
export async function runProviderDisconnect(
  ctx: CliContext,
  io: ProviderIoDeps = defaultProviderIo(),
): Promise<CommandOutcome> {
  const id = ctx.args.positionals[0];
  if (!id) {
    return {
      text: c.red("usage: prometheus provider disconnect <id>"),
      json: { ok: false, error: "missing-id" },
      exitCode: 2,
    };
  }
  const p = orchestration.apiProviderFor(id);
  if (!p) {
    return {
      text: c.red(`'${id}' is not a known API provider.`),
      json: { ok: false, error: "not-found", id },
      exitCode: 2,
    };
  }
  const account = providerAccount(p.id);
  let existing: string | undefined;
  try {
    existing = await io.secrets.get(secrets.SECRETS_SERVICE, account);
  } catch {
    existing = undefined;
  }
  if (!existing) {
    return {
      text: c.dim(`${p.label} is not configured in the keychain (nothing to disconnect).`),
      json: { ok: true, id: p.id, configured: false },
      exitCode: 0,
    };
  }
  const confirmed = ctx.args.yes === true || (await io.confirm());
  if (!confirmed) {
    return {
      text: `to disconnect ${c.bold(p.label)}, re-run with ${c.bold("--yes")} (or confirm the prompt).`,
      json: { ok: false, error: "confirm-required", id: p.id },
      exitCode: 2,
    };
  }
  try {
    await io.secrets.delete(secrets.SECRETS_SERVICE, account);
  } catch (e) {
    return {
      text: c.red(`keychain error: ${(e as Error).message}`),
      json: { ok: false, error: "keychain" },
      exitCode: 2,
    };
  }
  return {
    text: `${c.green("✓")} disconnected ${p.label} ${c.dim("(key removed from keychain)")}`,
    json: { ok: true, id: p.id },
    exitCode: 0,
  };
}

/* ── enable-metered: the §4.1 typed-confirm consent gate (CLI-031) ────────────── */

/** IO seam for `enable-metered` so tests inject the typed phrase (no real readline). */
export interface EnableMeteredDeps {
  /** read ONE line from the user (the typed phrase); default = a real readline read. */
  readLine: () => Promise<string>;
  /** wall clock for the receipt timestamp. */
  now: () => string;
  /** the prometheus home dir the consent persists under. */
  home: string;
  /** is there an interactive TTY to prompt on? default = real stdin.isTTY. */
  isTty: boolean;
}

const defaultEnableMeteredDeps = (): EnableMeteredDeps => ({
  readLine: readOneLine,
  now: () => new Date().toISOString(),
  home: prometheusHome(),
  isTty: process.stdin.isTTY === true,
});

/** Read a single line of stdin (cooked mode); resolves "" on EOF/non-TTY absence. */
function readOneLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = "";
    const onData = (b: Buffer): void => {
      buf += b.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        stdin.off("data", onData);
        stdin.pause();
        resolve(buf.slice(0, nl + 1)); // keep the newline for strict phrase matching
      }
    };
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", () => {
      stdin.off("data", onData);
      resolve(buf);
    });
  });
}

/**
 * `prometheus provider enable-metered <id>` — the §4.1 typed-confirm. Prints the cost warning,
 * then requires the EXACT phrase `ENABLE METERED` (case-sensitive, no trim; max 3 tries).
 * `--json` / non-TTY NEVER prompt (would hang a bridge) — they refuse fail-closed.
 */
export async function runProviderEnableMetered(
  ctx: CliContext,
  deps: EnableMeteredDeps = defaultEnableMeteredDeps(),
): Promise<CommandOutcome> {
  const id = ctx.args.positionals[0];
  if (!id) {
    return {
      text: c.red("usage: prometheus provider enable-metered <id>"),
      json: { ok: false, error: "missing-id" },
      exitCode: 2,
    };
  }
  const p = orchestration.apiProviderFor(id);
  if (!p) {
    return {
      text: c.red(`'${id}' is not a metered API provider. List with: prometheus provider status`),
      json: { ok: false, error: "not-found", id },
      exitCode: 2,
    };
  }
  if (hasMeteredConsent(p.id, deps.home)) {
    return {
      text: `${c.green("✓")} ${p.label} metered use is already enabled.`,
      json: { ok: true, id: p.id, alreadyEnabled: true },
      exitCode: 0,
    };
  }
  // A machine surface (or a non-TTY) must NOT prompt — refuse fail-closed with the how-to.
  if (ctx.json || !deps.isTty) {
    return {
      text: c.red(
        `metered provider "${p.id}" needs an interactive consent — run in a terminal: prometheus provider enable-metered ${p.id}`,
      ),
      json: { ok: false, reason: "interactive-consent-required", provider: p.id },
      exitCode: 2,
    };
  }
  // §4.1 warning card + the typed-confirm loop (max 3 tries, exact phrase).
  const line1 = `${c.yellow("⚠ METERED PROVIDER")} — ${c.bold(p.label)} bills your own API key PER TOKEN.`;
  const line2 = "  Prometheus never resells or shares keys; you pay the provider directly.";
  const line3 = `  To enable metered calls, type exactly: ${c.bold(ENABLE_METERED_PHRASE)}`;
  process.stderr.write(`${line1}\n${line2}\n${line3}\n`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    process.stderr.write(`  phrase (${attempt}/3): `);
    const line = await deps.readLine();
    if (isEnableMeteredPhrase(line)) {
      grantMeteredConsent(p.id, deps.now(), deps.home);
      return {
        text: `${c.green("✓")} metered use enabled for ${p.label}.`,
        json: { ok: true, id: p.id, enabled: true },
        exitCode: 0,
      };
    }
    if (attempt < 3)
      process.stderr.write(c.dim(`  wrong phrase — type exactly "${ENABLE_METERED_PHRASE}".\n`));
  }
  return {
    text: c.red("metered use NOT enabled (3 wrong attempts)."),
    json: { ok: false, reason: "consent-phrase-mismatch", provider: p.id },
    exitCode: 2,
  };
}
