/**
 * routes/extensions.tsx — the MCP / ACP connectors manager (file 09 §2).
 *
 * A REAL connector manager (replaced the old static copy-paste cheatsheet): it lists
 * the user's configured MCP servers with live health, and lets them add / enable /
 * disable / remove / import connectors — all backed by the main-process McpHostManager
 * over `window.prometheus.mcp.*` (persisted to disk, every launch command nemesis-gated
 * before it can connect). "Quick add" wires a handful of popular servers in one click;
 * "Import from agents…" pulls connectors already configured in Claude/Cursor/Codex/….
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the PLAIN-DATA contract types +
 * window.prometheus only. No node/electron/engine-bridge/core.
 */

import {
  type MarketplaceRow,
  type MarketplaceTab,
  MarketplaceView,
  McpServerList,
  type McpServerRow,
  Panel,
  type SortBy,
} from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import type { ExtInfoView, McpAddRequest, McpConnectorView } from "../shared/ipc-contract.js";
import {
  WARN_CONFIRM_PHRASE,
  extInfoToRow,
  installDecision,
  warnConfirmAccepted,
} from "./marketplace-ext.js";

function mcpApi(): Window["prometheus"]["mcp"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.mcp : undefined;
}
function extApi(): Window["prometheus"]["ext"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ext : undefined;
}
function securityApi(): Window["prometheus"]["security"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.security : undefined;
}

/** A few popular stdio MCP servers for one-click "Quick add" (npx-launched). */
const POPULAR: readonly { id: string; label: string; command: string; args: string[] }[] = [
  {
    id: "filesystem",
    label: "Filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
  },
  {
    id: "github",
    label: "GitHub",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  },
  { id: "git", label: "Git", command: "npx", args: ["-y", "@modelcontextprotocol/server-git"] },
  {
    id: "fetch",
    label: "Fetch (web)",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
  },
  {
    id: "memory",
    label: "Memory",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "sqlite",
    label: "SQLite",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sqlite"],
  },
];

/** Project the plain-data connector view → the reusable McpServerList row shape. */
function toRow(v: McpConnectorView): McpServerRow {
  return {
    id: v.id,
    label: v.label,
    health: v.health as McpServerRow["health"],
    source: v.source as McpServerRow["source"],
    transportKind: v.transportKind,
    ...(v.verdict ? { worstVerdict: v.verdict as McpServerRow["worstVerdict"] } : {}),
  };
}

const fieldStyle = {
  background: "var(--bg-inset)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-3, 6px)",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};
const btnStyle = {
  ...fieldStyle,
  cursor: "pointer",
  background: "var(--bg-surface-2)",
};

/** The existing MCP / ACP connector manager — UNCHANGED, now rendered as the marketplace's
 *  "MCP Servers" tab body (composed, not replaced — APP-060 acceptance #5). */
function McpManager(): ReactElement {
  const [servers, setServers] = useState<McpConnectorView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // add-form fields
  const [fId, setFId] = useState("");
  const [fLabel, setFLabel] = useState("");
  const [fKind, setFKind] = useState<"stdio" | "http">("stdio");
  const [fCommand, setFCommand] = useState("");
  const [fArgs, setFArgs] = useState("");
  const [fUrl, setFUrl] = useState("");
  // APP-095: optional `Key: value` headers (one per line) for a remote (http) server.
  const [fHeaders, setFHeaders] = useState("");

  const load = useCallback(async (): Promise<void> => {
    const api = mcpApi();
    if (!api) return;
    const r = await api.list();
    if (r.ok) setServers(r.servers);
    else setNotice(r.error ?? "failed to list connectors");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (id: string, next: boolean): Promise<void> => {
      const api = mcpApi();
      if (!api) return;
      setBusy(true);
      setNotice(next ? `connecting ${id}…` : `disabling ${id}…`);
      const r = await api.setEnabled(id, next);
      setNotice(r.ok ? null : `⚠ ${r.error ?? "toggle failed"}`);
      await load();
      setBusy(false);
    },
    [load],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      const api = mcpApi();
      if (!api) return;
      await api.remove(id);
      await load();
    },
    [load],
  );

  const importAgents = useCallback(async (): Promise<void> => {
    const api = mcpApi();
    if (!api) return;
    setBusy(true);
    setNotice("importing from installed agents…");
    const r = await api.import();
    setNotice(r.ok ? `imported ${r.imported} connector(s)` : `⚠ ${r.error ?? "import failed"}`);
    await load();
    setBusy(false);
  }, [load]);

  const doAdd = useCallback(
    async (req: McpAddRequest): Promise<void> => {
      const api = mcpApi();
      if (!api) return;
      setBusy(true);
      setNotice(`adding ${req.id} (nemesis-gating the launch command)…`);
      const r = await api.add(req);
      if (r.ok) setNotice(`added ${req.id} — enable it to connect`);
      else if (r.blocked) setNotice(`⛔ ${req.id} BLOCKED by nemesis (${r.verdict ?? "unsafe"})`);
      else setNotice(`⚠ ${r.error ?? "add failed"}`);
      await load();
      setBusy(false);
    },
    [load],
  );

  const quickAdd = useCallback(
    (p: (typeof POPULAR)[number]): void => {
      void doAdd({
        id: p.id,
        label: p.label,
        transport: { kind: "stdio", command: p.command, args: p.args },
      });
    },
    [doAdd],
  );

  const submitForm = useCallback((): void => {
    const id = fId.trim();
    const label = fLabel.trim() || id;
    if (!id) {
      setNotice("an id is required");
      return;
    }
    // parse `Key: value` header lines → a headers map (blank/comment lines ignored). The
    // main process re-validates the name allowlist + SSRF before any network I/O (fail-closed).
    const headers: Record<string, string> = {};
    for (const line of fHeaders.split("\n")) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const name = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim();
      if (name) headers[name] = val;
    }
    const transport: McpAddRequest["transport"] =
      fKind === "stdio"
        ? {
            kind: "stdio",
            command: fCommand.trim(),
            args: fArgs.trim() ? fArgs.trim().split(/\s+/) : [],
          }
        : {
            kind: "http",
            url: fUrl.trim(),
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          };
    void doAdd({ id, label, transport });
    setAddOpen(false);
    setFId("");
    setFLabel("");
    setFCommand("");
    setFArgs("");
    setFUrl("");
    setFHeaders("");
  }, [fId, fLabel, fKind, fCommand, fArgs, fUrl, fHeaders, doAdd]);

  const enabled = Object.fromEntries(servers.map((s) => [s.id, s.enabled]));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-6, 12px)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <Panel title="MCP / ACP connectors" elevation="e1">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
          {notice && (
            <div
              style={{
                fontSize: "var(--text-small-size, 0.8125rem)",
                color: "var(--text-secondary)",
                padding: "var(--space-2, 4px) 0",
              }}
            >
              {notice}
            </div>
          )}

          {servers.length === 0 ? (
            <div style={{ color: "var(--text-secondary)", padding: "var(--space-4, 8px) 0" }}>
              No connectors yet. Add one below, quick-add a popular server, or import from your
              installed agents.
            </div>
          ) : (
            <McpServerList
              servers={servers.map(toRow)}
              enabled={enabled}
              onToggle={(id, next) => void toggle(id, next)}
              onAdd={() => setAddOpen((o) => !o)}
              onImport={() => void importAgents()}
            />
          )}

          {servers.length === 0 && (
            <div style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
              <button type="button" onClick={() => setAddOpen((o) => !o)} style={btnStyle}>
                + Add server
              </button>
              <button type="button" onClick={() => void importAgents()} style={btnStyle}>
                Import from agents…
              </button>
            </div>
          )}

          {/* per-connector detail + remove (McpServerList omits these) */}
          {servers.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {servers.map((s) => (
                <li
                  key={s.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-3, 6px)",
                    fontSize: "var(--text-small-size, 0.8125rem)",
                    color: "var(--text-secondary)",
                    padding: "var(--space-1, 2px) 0",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {s.id} · {s.transportKind === "stdio" ? s.command : s.url} · {s.toolCount} tool
                    {s.toolCount === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove(s.id)}
                    disabled={busy}
                    style={{ ...btnStyle, color: "var(--danger)" }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* the add form */}
          {addOpen && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3, 6px)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-md, 6px)",
                padding: "var(--space-4, 8px)",
              }}
            >
              <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
                <input
                  placeholder="id (e.g. github)"
                  value={fId}
                  onChange={(e) => setFId(e.target.value)}
                  aria-label="connector id"
                  style={fieldStyle}
                />
                <input
                  placeholder="label"
                  value={fLabel}
                  onChange={(e) => setFLabel(e.target.value)}
                  aria-label="connector label"
                  style={fieldStyle}
                />
                <select
                  value={fKind}
                  onChange={(e) => setFKind(e.target.value as "stdio" | "http")}
                  aria-label="transport kind"
                  style={fieldStyle}
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                </select>
              </div>
              {fKind === "stdio" ? (
                <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
                  <input
                    placeholder="command (e.g. npx)"
                    value={fCommand}
                    onChange={(e) => setFCommand(e.target.value)}
                    aria-label="command"
                    style={fieldStyle}
                  />
                  <input
                    placeholder="args (space-separated)"
                    value={fArgs}
                    onChange={(e) => setFArgs(e.target.value)}
                    aria-label="args"
                    style={{ ...fieldStyle, flex: 1, minWidth: 220 }}
                  />
                </div>
              ) : (
                <>
                  <input
                    placeholder="https://server/mcp"
                    value={fUrl}
                    onChange={(e) => setFUrl(e.target.value)}
                    aria-label="http url"
                    style={fieldStyle}
                  />
                  {/* APP-095: optional request headers (Authorization / X-Api-Key), one per
                      line — validated (name allowlist + https/localhost-only) in main. */}
                  <textarea
                    placeholder={"Headers (optional), one per line:\nAuthorization: Bearer …"}
                    value={fHeaders}
                    onChange={(e) => setFHeaders(e.target.value)}
                    aria-label="http headers"
                    rows={2}
                    style={{ ...fieldStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
                  />
                </>
              )}
              <div style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
                <button type="button" onClick={submitForm} disabled={busy} style={btnStyle}>
                  Add + gate
                </button>
                <button type="button" onClick={() => setAddOpen(false)} style={btnStyle}>
                  Cancel
                </button>
              </div>
              <span
                style={{
                  fontSize: "var(--text-small-size, 0.8125rem)",
                  color: "var(--text-secondary)",
                }}
              >
                {fKind === "stdio"
                  ? "The launch command is scanned by nemesis before the server can connect."
                  : // An http connector has no command and no source to read, so nemesis
                    // never runs on it: engine-bridge's MCP gate short-circuits `kind:
                    // "endpoint"` to a hardcoded allow. The real check is the host's
                    // SSRF/allow-list validation of the URL — saying "scanned by nemesis"
                    // here claimed a scan that does not happen.
                    "The URL is checked against the SSRF and allow-list rules before the server can connect. Remote endpoints are not scanned by nemesis — there is no command or source to read."}
              </span>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Quick add — popular servers" elevation="e1">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3, 6px)" }}>
          {POPULAR.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => quickAdd(p)}
              disabled={busy || servers.some((s) => s.id === p.id)}
              title={`npx ${p.args.join(" ")}`}
              style={btnStyle}
            >
              + {p.label}
            </button>
          ))}
        </div>
      </Panel>

      <SettingsSyncPanel />
    </div>
  );
}

/** APP-095: git-backed settings sync — choose a repo dir, Push (commit+push a redacted bundle)
 *  / Pull (fetch + apply keymap+themes after an explicit confirm). Renderer-only view over
 *  `window.prometheus.settingsSync.*`; the redaction + git ops live in main. */
function SettingsSyncPanel(): ReactElement {
  const [repoDir, setRepoDir] = useState("");
  const [status, setStatus] = useState<{ kind: "error" | "ok"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // a pulled bundle awaiting the user's explicit "apply" confirm (never auto-applied).
  const [pending, setPending] = useState<{
    base: string;
    overrides: number;
    themes: number;
  } | null>(null);
  const pulledRef = useRef<import("../shared/ipc-contract.js").SettingsSyncBundle | null>(null);

  const pickDir = async (): Promise<void> => {
    const r = await window.prometheus
      ?.folderOpen?.({ title: "Choose settings repo" })
      .catch(() => undefined);
    if (r?.ok && r.path) setRepoDir(r.path);
  };

  const push = async (): Promise<void> => {
    const api = window.prometheus?.settingsSync;
    if (!api || !repoDir) return;
    setBusy(true);
    setStatus(null);
    // gather the renderer-owned settings (keymap-overrides.ts + ThemeProvider keys).
    const ls = window.localStorage;
    const keymap = {
      base: ls.getItem("prometheus.keymap.base") || "default",
      overrides: JSON.parse(ls.getItem("prometheus.keymap.userBindings") || "[]"),
    };
    const themes = JSON.parse(ls.getItem("prometheus.customSchemes") || "[]");
    const r = await api.push({ repoDir, keymap, themes }).catch(() => undefined);
    setBusy(false);
    setStatus(
      r?.ok
        ? { kind: "ok", message: r.message ?? "pushed" }
        : { kind: "error", message: r?.error ?? "push failed" },
    );
  };

  const pull = async (): Promise<void> => {
    const api = window.prometheus?.settingsSync;
    if (!api || !repoDir) return;
    setBusy(true);
    setStatus(null);
    const r = await api.pull({ repoDir }).catch(() => undefined);
    setBusy(false);
    if (!r?.ok || !r.bundle) {
      setStatus({ kind: "error", message: r?.error ?? "pull failed" });
      return;
    }
    // do NOT auto-apply — stash the pulled bundle for an explicit confirm.
    pulledRef.current = r.bundle;
    setPending({
      base: r.bundle.keymap.base,
      overrides: r.bundle.keymap.overrides.length,
      themes: r.bundle.themes.length,
    });
  };

  const applyPending = (): void => {
    const bundle = pulledRef.current;
    if (!bundle) return;
    const ls = window.localStorage;
    ls.setItem("prometheus.keymap.base", bundle.keymap.base);
    ls.setItem("prometheus.keymap.userBindings", JSON.stringify(bundle.keymap.overrides));
    window.dispatchEvent(new CustomEvent("prometheus:keymap-changed"));
    ls.setItem("prometheus.customSchemes", JSON.stringify(bundle.themes));
    setPending(null);
    setStatus({ kind: "ok", message: "applied keymap + themes (reload to repaint themes)" });
  };

  return (
    <Panel title="Settings sync (git)" elevation="e1">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3, 6px)" }}>
        <div
          style={{
            display: "flex",
            gap: "var(--space-2, 4px)",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <button type="button" onClick={() => void pickDir()} style={btnStyle}>
            Choose repo…
          </button>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {repoDir || "no repo chosen"}
          </span>
          <button
            type="button"
            onClick={() => void push()}
            disabled={busy || !repoDir}
            style={btnStyle}
          >
            ⭱ Push
          </button>
          <button
            type="button"
            onClick={() => void pull()}
            disabled={busy || !repoDir}
            style={btnStyle}
          >
            ⭳ Pull
          </button>
        </div>
        <span
          style={{ fontSize: "var(--text-small-size, 0.8125rem)", color: "var(--text-secondary)" }}
        >
          Pushes keymap, custom themes, and connector configs — API keys / tokens are stripped
          (never committed). Pulled settings apply only after you confirm.
        </span>
        {pending && (
          <div
            role="alert"
            style={{
              padding: "var(--space-2, 4px) var(--space-3, 6px)",
              borderRadius: "var(--radius-sm, 4px)",
              background: "var(--bg-inset)",
              border: "1px solid var(--warn)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            Pulled: base {pending.base} · {pending.overrides} rebinds · {pending.themes} themes.{" "}
            <button
              type="button"
              onClick={applyPending}
              style={{ ...btnStyle, color: "var(--accent)" }}
            >
              Apply
            </button>{" "}
            <button type="button" onClick={() => setPending(null)} style={btnStyle}>
              Discard
            </button>
          </div>
        )}
        {status && (
          <span
            style={{
              fontSize: "var(--text-small-size, 0.8125rem)",
              color: status.kind === "error" ? "var(--danger)" : "var(--ok)",
            }}
          >
            {status.message}
          </span>
        )}
      </div>
    </Panel>
  );
}

/* ── the marketplace container (APP-060): MarketplaceView + gated install ─────── */

const cardBtn = { ...btnStyle };

/** An in-progress install: the picked archive + its gate verdict (or a gate error). */
interface InstallFlow {
  path: string;
  tier?: string;
  findings?: { ruleId: string; detail: string }[];
  error?: string;
}

export function ExtensionsRoute(): ReactElement {
  const [tab, setTab] = useState<MarketplaceTab>("extensions");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortBy>("name");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exts, setExts] = useState<ExtInfoView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<InstallFlow | null>(null);
  const [warnTyped, setWarnTyped] = useState("");

  const loadExts = useCallback(async (): Promise<void> => {
    const api = extApi();
    if (!api) return;
    const r = await api.list();
    if (r.ok) setExts(r.extensions ?? []);
    else setNotice(r.error ?? "failed to list extensions");
  }, []);

  useEffect(() => {
    void loadExts();
  }, [loadExts]);

  // installed extensions → marketplace rows (guarded against a partial payload).
  const rows: MarketplaceRow[] = (exts ?? []).map(extInfoToRow);
  const selectedExt = (exts ?? []).find((e) => e.id === selectedId) ?? null;

  /** Pick a .promext, run the nemesis gate (rich), and open the verdict card. */
  const pickAndGate = useCallback(async (): Promise<void> => {
    const fo = await window.prometheus?.fileOpen?.({ title: "Choose a .promext extension" });
    if (!fo?.ok || !fo.path) return;
    setBusy(true);
    setWarnTyped("");
    setNotice("nemesis-gating the extension…");
    const g = await securityApi()?.gateFull(fo.path);
    setBusy(false);
    setNotice(null);
    if (!g?.ok || !g.verdict) {
      setFlow({ path: fo.path, error: g?.error ?? "gate failed" });
      return;
    }
    setFlow({
      path: fo.path,
      tier: g.verdict.verdict,
      findings: (g.verdict.top_findings ?? []).map((f) => ({
        ruleId: f.rule_id,
        detail: f.detail,
      })),
    });
  }, []);

  /** Confirm + run the install (RED never reaches here; WARN needs the typed literal). */
  const confirmInstall = useCallback(async (): Promise<void> => {
    if (!flow?.path) return;
    const decision = installDecision(flow.tier);
    if (decision === "blocked") return;
    if (decision === "confirm-warn" && !warnConfirmAccepted(warnTyped)) {
      setNotice(`type "${WARN_CONFIRM_PHRASE}" to proceed`);
      return;
    }
    setBusy(true);
    setNotice("installing…");
    const api = extApi();
    const r = await api?.install(flow.path);
    if (r?.ok) {
      if (r.id) await api?.rescan(r.id); // store the verdict so the chip persists
      setNotice(`installed ${r.id}`);
      setFlow(null);
      await loadExts();
    } else {
      setNotice(`⚠ ${r?.error ?? "install failed"}${r?.code ? ` (${r.code})` : ""}`);
      setFlow(null);
    }
    setBusy(false);
  }, [flow, warnTyped, loadExts]);

  /** Enable/disable → real host activation, persisted for the next launch. */
  const setEnabled = useCallback(
    async (id: string, enable: boolean): Promise<void> => {
      const api = extApi();
      if (!api) return;
      setBusy(true);
      const r = enable ? await api.activate(id) : await api.deactivate(id);
      setNotice(r?.ok ? null : `⚠ ${r?.error ?? "toggle failed"}`);
      await loadExts();
      setBusy(false);
    },
    [loadExts],
  );

  const rescan = useCallback(
    async (id: string): Promise<void> => {
      const api = extApi();
      if (!api) return;
      setBusy(true);
      setNotice("rescanning…");
      const r = await api.rescan(id);
      setNotice(r?.ok ? `scan: ${r.verdict?.tier ?? "?"}` : `⚠ ${r?.error ?? "rescan failed"}`);
      await loadExts();
      setBusy(false);
    },
    [loadExts],
  );

  const decision = installDecision(flow?.tier);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3, 6px)",
          padding: "var(--space-3, 6px) var(--space-4, 8px)",
        }}
      >
        <button type="button" onClick={() => void pickAndGate()} disabled={busy} style={cardBtn}>
          Install extension (.promext)…
        </button>
        {notice && (
          <span
            style={{
              color: "var(--text-secondary)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            {notice}
          </span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <MarketplaceView
          tab={tab}
          onTabChange={setTab}
          // only show the WIRED tabs — Plugins/Skills have no data source here, so
          // advertising them meant two permanently-empty tabs ("absurdly empty").
          tabs={[
            { id: "extensions", label: "Extensions" },
            { id: "mcp", label: "MCP Servers" },
          ]}
          query={query}
          onQueryChange={setQuery}
          sort={sort}
          onSortChange={setSort}
          rows={tab === "extensions" ? rows : []}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onInstall={(row) => setSelectedId(row.id)}
          mcpSlot={<McpManager />}
        />
      </div>

      {/* the gated-install verdict card (§6): RED blocks, WARN needs a typed confirm. */}
      {flow && (
        <div
          style={{
            borderTop: "2px solid var(--border-strong)",
            padding: "var(--space-4, 8px)",
            background: "var(--bg-surface)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2, 4px)",
          }}
        >
          <strong>Install verdict</strong>
          {flow.error ? (
            <span style={{ color: "var(--danger)" }}>⚠ scan failed: {flow.error}</span>
          ) : (
            <>
              <span
                style={{
                  color:
                    decision === "blocked"
                      ? "var(--danger)"
                      : decision === "confirm-warn"
                        ? "var(--warn)"
                        : "var(--ok)",
                }}
              >
                verdict: {flow.tier} —{" "}
                {decision === "blocked"
                  ? "BLOCKED (nemesis will not allow this install)"
                  : decision === "confirm-warn"
                    ? "warnings found — review below"
                    : "clean"}
              </span>
              {(flow.findings ?? []).length > 0 && (
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: "var(--space-6, 12px)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {(flow.findings ?? []).slice(0, 20).map((f, i) => (
                    <li
                      key={`${f.ruleId}:${i}`}
                      style={{ fontSize: "var(--text-small-size, 0.8125rem)" }}
                    >
                      {f.ruleId}: {f.detail}
                    </li>
                  ))}
                </ul>
              )}
              {decision === "confirm-warn" && (
                <input
                  value={warnTyped}
                  onChange={(e) => setWarnTyped(e.target.value)}
                  placeholder={`type "${WARN_CONFIRM_PHRASE}" to proceed`}
                  aria-label="typed install confirmation"
                  style={fieldStyle}
                />
              )}
            </>
          )}
          <div style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
            {!flow.error && decision !== "blocked" && (
              <button
                type="button"
                onClick={() => void confirmInstall()}
                disabled={busy || (decision === "confirm-warn" && !warnConfirmAccepted(warnTyped))}
                style={cardBtn}
              >
                Install
              </button>
            )}
            <button type="button" onClick={() => setFlow(null)} style={cardBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* the manage panel for a selected installed extension (enable/disable/rescan). */}
      {!flow && tab === "extensions" && selectedExt && (
        <div
          style={{
            borderTop: "1px solid var(--border-subtle)",
            padding: "var(--space-4, 8px)",
            background: "var(--bg-surface)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2, 4px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3, 6px)" }}>
            <strong>{selectedExt.label}</strong>
            <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
              v{selectedExt.version}
            </span>
            <span style={{ color: selectedExt.active ? "var(--ok)" : "var(--text-secondary)" }}>
              {selectedExt.active ? "● active" : "○ disabled"}
            </span>
          </div>
          {(selectedExt.permissions ?? []).length > 0 && (
            <ul
              style={{
                margin: 0,
                paddingLeft: "var(--space-6, 12px)",
                color: "var(--text-secondary)",
              }}
            >
              {(selectedExt.permissions ?? []).map((p) => (
                <li key={p} style={{ fontSize: "var(--text-small-size, 0.8125rem)" }}>
                  {p}
                </li>
              ))}
            </ul>
          )}
          <div style={{ display: "flex", gap: "var(--space-3, 6px)" }}>
            <button
              type="button"
              onClick={() => void setEnabled(selectedExt.id, !selectedExt.enabled)}
              disabled={busy}
              style={cardBtn}
            >
              {selectedExt.enabled ? "Disable" : "Enable"}
            </button>
            <button
              type="button"
              onClick={() => void rescan(selectedExt.id)}
              disabled={busy}
              style={cardBtn}
            >
              Rescan
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ExtensionsRoute;
