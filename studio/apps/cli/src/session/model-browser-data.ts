// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/model-browser-data.ts — the rows of the full-screen `/model` browser.
 *
 * Every verdict here comes from the same core planner the typed command uses
 * (`ai.localVerdict`, `ai.preparePlan`), so the browser can never promise what
 * `/models use <ref>` would then refuse: a row the browser shows as runnable is a ref the shared
 * prepare-and-switch path will prepare, on the server the row names. Built once, BEFORE the
 * browser opens (the browser has no async state), from one `host.context()`.
 */
import { ai } from "@prometheus/core";

import type {
  BrowserBadge,
  BrowserData,
  BrowserItem,
  BrowserLayer,
  DetailLine,
} from "../tui/model-browser.js";
import type { ModelsHost } from "./models-host.js";
import type { ServerRow } from "./server-cmd.js";

const TIERS: readonly {
  id: NonNullable<ai.LocalModelEntry["tier"]>;
  label: string;
  note: string;
}[] = [
  { id: "tiny", label: "Tiny", note: "2–4 GB RAM" },
  { id: "light", label: "Light", note: "6–8 GB RAM" },
  { id: "moderate", label: "Moderate", note: "12–16 GB RAM" },
  { id: "heavy", label: "Heavy", note: "24–32 GB RAM" },
  { id: "workstation", label: "Workstation", note: "48–64 GB RAM" },
  { id: "server", label: "Server", note: "96–256 GB RAM" },
  { id: "datacenter", label: "Datacenter", note: "384 GB – 2 TB RAM" },
];

const fmtCtx = (n: number): string =>
  n >= 1_000_000
    ? `${Math.round(n / 104857.6) / 10}M`
    : n >= 1000
      ? `${Math.round(n / 1024)}K`
      : `${n}`;
const fmtGb = (gb: number): string =>
  gb >= 1024 ? `${Math.round((gb / 1024) * 10) / 10} TB` : `${Math.round(gb)} GB`;

/** One line per prepare step: what choosing the row will actually do, in order. */
export function describeAction(a: ai.PrepareAction): string {
  switch (a.kind) {
    case "install-runner":
      return "install Ollama (Homebrew, gated)";
    case "start-runner":
      return "start Ollama";
    case "confirm-insist":
      return `you type ${a.id} to confirm streaming it from disk (${a.runtimeName})`;
    case "install-offload":
      return `${a.runtime.name}: shown, not run`;
    case "pull":
      return `download ${a.tag} through Ollama (≈${a.sizeGb} GB), then a nemesis scan`;
    case "fetch-gguf":
      return `download ${a.file.split("/").pop()} (≈${a.sizeGb} GB) from Hugging Face — sha256 + nemesis`;
    case "fetch-snapshot":
      return `download ${a.repo} (weights, config, tokenizer — no code) — sha256 + nemesis`;
    case "import-ollama":
      return `serve it through Ollama as ${a.tag}`;
    case "install-runtime":
      return `install ${ai.SERVE_RUNTIME_NAMES[a.runtime]}${a.runtime === "airllm" ? " (gated pip, own venv)" : a.runtime === "colibri" ? " (pinned source, scanned, built here)" : ""}`;
    case "serve-gguf":
      return a.stream
        ? `start llama-server on the file, weights paged from disk (${fmtCtx(a.ctx)} context)`
        : `start llama-server on the file, offline (${fmtCtx(a.ctx)} context)`;
    case "serve-mlx":
      return "start MLX-LM on the model, offline";
    case "serve-stream":
      return "start AirLLM on the model, offline (first start splits it into layers)";
    case "serve-colibri":
      return "colibri reads the GGUF in place and serves it on 127.0.0.1 with a session key";
    case "link-lmstudio":
      return a.format === "mlx"
        ? "link the MLX folder into LM Studio (no copy)"
        : "link the GGUF into LM Studio (no copy)";
    case "start-runtime":
      return "start LM Studio's server";
    case "set-key":
      return "add the provider's API key (stored in your keychain)";
    case "adopt":
      return "switch this session to it";
  }
}

function badgeFor(v: ai.LocalVerdict, installed: boolean, noDisk = false): BrowserBadge {
  if (v.plan.kind === "too-big") return "too-big";
  if (v.disabled) return "no-build";
  // the browser never promises what `/models use` refuses: no room on disk = not runnable here
  if (!installed && noDisk) return "no-disk";
  if (v.plan.quant === "small") return "small-quant";
  if (v.plan.tier === "tight") return "tight";
  return installed ? "installed" : "fits";
}

function traitsOf(m: ai.LocalModelEntry): string[] {
  const t: string[] = [];
  if (m.tags.includes("coding") || m.tags.includes("code")) t.push("coding");
  if (m.tools) t.push("tools");
  if (m.reasoning || m.tags.includes("reasoning")) t.push("reasoning");
  if (m.vision || m.tags.includes("vision")) t.push("vision");
  return t;
}

function localItem(
  m: ai.LocalModelEntry,
  pctx: ai.PrepareContext,
  installedTags: ReadonlySet<string>,
): BrowserItem {
  const v = ai.localVerdict(m, pctx);
  const installed =
    installedTags.has(ai.localOllamaTag(m).toLowerCase()) ||
    (m.ollama !== undefined && installedTags.has(m.ollama.toLowerCase()));
  const smallPick = v.plan.kind === "native" && v.plan.quant === "small";
  const noDisk =
    ai.diskFits(m, pctx.machine, undefined, smallPick ? (m.smallGb ?? m.q4Gb) : m.q4Gb) === false;
  const badge = badgeFor(v, installed, noDisk);
  const ref = `local:${m.id}`;
  const small = v.plan.kind === "native" && v.plan.quant === "small";
  const needGb = small && m.smallMinRamGb !== undefined ? m.smallMinRamGb : m.minRamGb;
  const best = v.insist[0];
  const VIA: Record<string, string> = {
    colibri: "via colibri",
    "llamacpp-stream": "via SSD",
    airllm: "via AirLLM",
  };
  const runner =
    v.plan.kind === "too-big"
      ? best
        ? (VIA[best.runtime.id] ?? "streamed")
        : "too big"
      : v.choice?.runtime
        ? ai.SERVE_RUNTIME_NAMES[v.choice.runtime]
        : "—";
  const activeId = pctx.activeId ?? "";
  return {
    key: m.id,
    label: m.label,
    lines: [m.blurb.strengths, m.blurb.limits],
    badge,
    need: fmtGb(needGb),
    runner,
    ...(v.disabled ? { disabled: v.disabled } : { submit: `/models use ${ref}` }),
    ...(best
      ? {
          insist: {
            submit: `/models use local:${m.id}@${best.runtime.id}`,
            runtime: best.runtime.name,
            speed: best.runtime.speed,
          },
        }
      : {}),
    ...(activeId.endsWith(`:${m.id}`) ||
    (m.ollama && activeId.endsWith(`:${m.ollama}`)) ||
    // a GGUF imported into Ollama is served as `prometheus/<id>` (import-ollama's tag)
    activeId.endsWith(`:${ai.localOllamaTag(m)}`) ||
    activeId.endsWith(`prometheus/${m.id}`)
      ? { current: true }
      : {}),
    search: [
      m.id,
      m.label,
      m.publisher ?? "",
      m.family ?? "",
      m.tags.join(" "),
      m.blurb.strengths,
      m.blurb.limits,
      m.ollama ?? "",
    ]
      .join(" ")
      .toLowerCase(),
    traits: traitsOf(m),
    sort: {
      ramGb: needGb,
      name: m.label.toLowerCase(),
      released: m.released ?? "",
      paramsB: m.paramsB ?? m.q4Gb * 2,
    },
    ram: { needGb, totalGb: pctx.machine.ramGb },
    details: () => localDetails(m, v, pctx),
  };
}

function localDetails(
  m: ai.LocalModelEntry,
  v: ai.LocalVerdict,
  pctx: ai.PrepareContext,
): DetailLine[] {
  const out: DetailLine[] = [];
  const size =
    m.paramsB !== undefined
      ? `${m.paramsB}B${m.activeB !== undefined ? ` (${m.activeB}B active)` : ""}`
      : "MoE";
  out.push(
    [m.publisher, size, `${fmtCtx(m.context)} context`, m.license, m.released]
      .filter(Boolean)
      .join(" · "),
  );
  if (m.resourceLabel) out.push({ text: m.resourceLabel, role: "muted" });
  out.push("");
  const role =
    v.plan.kind === "too-big" || v.disabled
      ? "danger"
      : v.plan.kind === "native" && v.plan.tier === "tight"
        ? "warn"
        : "traitOn";
  out.push({ text: v.line, role });
  const plan = ai.preparePlan({ section: "local", id: m.id }, pctx);
  if (plan.runtime) {
    out.push(
      `Runs on ${ai.SERVE_RUNTIME_NAMES[plan.runtime]}${plan.runtimeReason ? ` — ${plan.runtimeReason}` : ""}.`,
    );
  }
  if (plan.switchDefault) {
    out.push({
      text: `Your default server moves from ${ai.DEFAULT_SERVER_INFO[plan.switchDefault.from].name} to ${ai.DEFAULT_SERVER_INFO[plan.switchDefault.to].name} once it is ready.`,
      role: "info",
    });
  }
  if (!plan.blocked && plan.actions.length > 0) {
    out.push("");
    out.push({ text: "Enter will:", role: "heading" });
    plan.actions.forEach((a, i) => out.push(`  ${i + 1}. ${describeAction(a)}`));
    out.push({ text: "  (every install and download asks you first)", role: "muted" });
  }
  for (const w of plan.warnings) out.push({ text: `⚠ ${w}`, role: "warn" });
  if (v.insist.length > 0) {
    out.push("");
    out.push({ text: "! runs it anyway, streaming it from disk:", role: "heading" });
    for (const o of v.insist) {
      out.push(`  ${o.runtime.name}${o.interactive ? "" : " (offline jobs only)"} — ${o.why}`);
      out.push({ text: `    ${o.runtime.speed}`, role: "muted" });
    }
    out.push({
      text: "  You will be asked to type the model's id before anything is installed.",
      role: "muted",
    });
  }
  if (m.gate) {
    out.push("");
    out.push({
      text: `Gate: ${m.gate.status} — every download is scanned by nemesis`,
      role: m.gate.status === "vetted" ? "traitOn" : "warn",
    });
    for (const n of m.gate.notes) out.push({ text: `  · ${n}`, role: "muted" });
  }
  const coords = [
    m.ollama ? `Ollama ${m.ollama}` : "",
    m.gguf
      ? `GGUF ${m.gguf.repo}${(m.gguf.shards ?? 1) > 1 ? ` (${m.gguf.shards} files)` : ""}`
      : "",
    m.mlx ? `MLX ${m.mlx}` : "",
  ].filter(Boolean);
  if (coords.length) {
    out.push("");
    for (const c of coords) out.push({ text: c, role: "muted" });
  }
  return out;
}

function rowItem(row: ai.WizardRow, badge: BrowserBadge, runner: string): BrowserItem {
  const [a = "", b = ""] = row.lines;
  return {
    key: row.ref ?? row.label,
    label: row.label,
    lines: [a, b],
    badge,
    runner,
    ...(row.ref && !row.disabled ? { submit: `/models use ${row.ref}` } : {}),
    ...(row.disabled ? { disabled: row.disabled } : {}),
    ...(row.current ? { current: true } : {}),
    search: [row.label, row.detail, ...row.lines].join(" ").toLowerCase(),
    traits: /tools/i.test(row.detail) ? ["tools"] : [],
    sort: { ramGb: 0, name: row.label.toLowerCase(), released: "", paramsB: 0 },
    details: () => [row.detail, "", ...row.lines.map((l) => l)],
  };
}

/** Everything the browser shows, measured once. */
export async function buildModelBrowser(
  host: ModelsHost,
  opts: { servers?: readonly ServerRow[]; start?: string } = {},
): Promise<BrowserData> {
  const pctx = await host.context();
  const m = pctx.machine;
  const installedTags = new Set((pctx.installedOllama ?? []).map((t) => t.toLowerCase()));
  const all = ai.LOCAL_MODELS.map((x) => localItem(x, pctx, installedTags));
  const byId = new Map(ai.LOCAL_MODELS.map((x, i) => [x.id, all[i] as BrowserItem]));

  const served: BrowserItem[] = (pctx.served ?? []).map((s) => {
    const known = ai.findLocalModel(s.model);
    const ref = `served:${s.runner}:${s.model}`;
    return {
      key: ref,
      label: known ? `${known.label} (${s.model})` : s.model,
      lines: known
        ? [known.blurb.strengths, known.blurb.limits]
        : [
            "Already loaded by your local server — ready instantly.",
            "Not in the Prometheus catalogue.",
          ],
      badge: "serving",
      runner: s.runner,
      submit: `/models use ${ref}`,
      ...(pctx.activeId === `local:${s.runner}:${s.model}` ? { current: true } : {}),
      search: `${s.model} ${s.runner} ${known?.label ?? ""}`.toLowerCase(),
      traits: known ? traitsOf(known) : [],
      sort: {
        ramGb: known?.minRamGb ?? 0,
        name: s.model.toLowerCase(),
        released: known?.released ?? "",
        paramsB: known?.paramsB ?? 0,
      },
      ...(known ? { ram: { needGb: known.minRamGb, totalGb: m.ramGb } } : {}),
      details: () => [
        `Served by ${s.runner} right now — nothing to download.`,
        ...(known
          ? ["", ...localDetails(known, ai.localVerdict(known, pctx), pctx).slice(0, 2)]
          : []),
      ],
    };
  });

  const fits = ai.LOCAL_MODELS.filter((x) => {
    const it = byId.get(x.id);
    return it !== undefined && it.submit !== undefined;
  }).map((x) => byId.get(x.id) as BrowserItem);

  const layers: BrowserLayer[] = [
    {
      id: "serving",
      label: "Serving now",
      depth: 0,
      items: served,
      empty:
        "No local server is serving a model right now. Pick one below — Prometheus starts the server it needs.",
    },
    {
      id: "fits",
      label: "Fits this machine",
      depth: 0,
      items: fits,
      note: `${fmtGb(ai.modelBudgetGb(m))} budget`,
    },
    {
      id: "local",
      label: "All local models",
      depth: 0,
      items: all,
      note: "too-big rows stay visible",
    },
    ...TIERS.map((t) => ({
      id: `tier:${t.id}`,
      label: t.label,
      depth: 1 as const,
      note: t.note,
      items: ai.LOCAL_MODELS.filter((x) => x.tier === t.id).map(
        (x) => byId.get(x.id) as BrowserItem,
      ),
    })),
  ];
  const free = ai.wizardStep("free", pctx);
  layers.push({
    id: "free",
    label: "Cloud · free",
    depth: 0,
    items: free.rows.map((r) =>
      rowItem(r, r.badge === "needs-key" ? "needs-key" : "cloud", "cloud"),
    ),
  });
  const paid = ai.wizardStep("paid", pctx);
  layers.push({
    id: "paid",
    label: "Cloud · paid",
    depth: 0,
    items: paid.rows.map((r) =>
      rowItem(r, r.badge === "needs-key" ? "needs-key" : "cloud", "cloud"),
    ),
  });
  const rot = ai.wizardStep("rotation", pctx);
  layers.push({
    id: "rotation",
    label: "Endless free spinner",
    depth: 0,
    items: [
      {
        key: "rotation",
        label: "Endless free spinner",
        lines: [
          "One model that never runs dry: when a free quota ends, the next provider takes over.",
          "Answers can come from different models turn to turn; prompts go to several providers.",
        ],
        badge: (pctx.rotation ?? []).length > 0 ? "cloud" : "needs-key",
        runner: `${(pctx.rotation ?? []).length} free`,
        submit: "/models use rotation",
        search: "spinner rotation free endless",
        sort: { ramGb: 0, name: "spinner", released: "", paramsB: 0 },
        details: () => [...rot.intro, "", ...rot.rows.map((r) => `· ${r.label} — ${r.detail}`)],
      },
    ],
  });
  layers.push({
    id: "servers",
    label: "Model servers",
    depth: 0,
    note: "the default for new picks",
    items: (opts.servers ?? []).map((r) => ({
      key: `server:${r.id}`,
      label: r.name,
      lines: [`${r.state} — ${r.lines[0]}`, r.lines[1]],
      badge: "server",
      runner: r.current ? "default" : "",
      submit: `/server ${r.id}`,
      ...(r.current ? { current: true } : {}),
      search: `${r.id} ${r.name} server`,
      sort: { ramGb: 0, name: r.name.toLowerCase(), released: "", paramsB: 0 },
      details: () => [
        `${r.name} — ${r.state}`,
        "",
        ...r.lines,
        "",
        {
          text: "Enter makes it the default server. A pick that needs a different server moves the default to that one by itself.",
          role: "muted",
        },
      ],
    })),
  });

  const def = ai.defaultServerFrom({ [ai.DEFAULT_SERVER_KEY]: pctx.defaultServer });
  const defRow = (opts.servers ?? []).find((r) => r.id === def);
  const machine = [
    `${m.ramGb} GB${m.unified ? " unified (Apple Silicon)" : " RAM"}`,
    ...(m.vramGb > 0 ? [`${m.vramGb} GB GPU`] : []),
    ...(m.freeDiskGb !== undefined ? [`${fmtGb(m.freeDiskGb)} free disk`] : []),
  ].join(" · ");
  const start = opts.start ?? (served.length > 0 ? "serving" : "fits");
  return {
    machine,
    server: `default server: ${ai.DEFAULT_SERVER_INFO[def].name}${defRow ? ` · ${defRow.state}` : ""}`,
    ram: {
      totalGb: m.ramGb,
      ...(m.freeRamGb !== undefined ? { freeGb: m.freeRamGb } : {}),
      budgetGb: ai.modelBudgetGb(m),
    },
    layers,
    start,
  };
}

/** `/models <word>` → the layer the browser opens on. */
export function browserStartFor(step: string | undefined): string | undefined {
  switch ((step ?? "").toLowerCase()) {
    case "local":
      return "fits";
    case "free":
      return "free";
    case "paid":
      return "paid";
    case "cloud":
      return "free";
    case "spinner":
    case "rotation":
      return "rotation";
    case "servers":
    case "server":
      return "servers";
    case "all":
      return "local";
    default:
      return undefined;
  }
}
