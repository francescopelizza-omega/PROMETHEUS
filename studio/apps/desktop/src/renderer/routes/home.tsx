/**
 * routes/home.tsx — Home / MISSION CONTROL (handoff §2.3, file 08 §5.1).
 *
 * A 1180px-wide centred column of five things, in this order:
 *   1. greeting (24px/700) + a one-line security tagline, with live gate/engine chips
 *      right-aligned;
 *   2. the ASK BAR — a 52px island with the gradient "Ask AI →" CTA; typing here and
 *      sending seeds the agent rail with the draft;
 *   3. four quick actions (Open folder · Clone repo · Browse catalog · Model hub);
 *   4. an islands grid: System health · Last gate verdict · Models · Recent projects
 *      (+ Servers when the C8 supervisor reports any);
 *   5. nothing else — an island with no content does not render (§2.3).
 *
 * Every island implements the §6 five-state contract: empty / loading / degraded /
 * error / populated. "Degraded" is the load-bearing one — when the engine is
 * unreachable an island shows the LAST KNOWN state greyed with the real error and a
 * "Run doctor" action, never a blank card and never a crash.
 *
 * All sizes are authored in explicit px (handoff §1 density decision) — the 112.5%
 * root scale is gone, so rem-authored chrome would silently shrink.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + TanStack Query + the renderer
 * stores + window.prometheus only. No node/electron/engine-bridge.
 */

import * as tokenEconomy from "@prometheus/core/token-economy";
import {
  ActivityIcon,
  type ActivityId,
  StatusPill,
  VerdictCard,
  type VerdictCardFinding,
  deriveShield,
  healthStatusGlyph,
  healthStatusRole,
} from "@prometheus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";

import { requestRouteTab } from "../../routes/route-tabs.js";
import type { GateResult, ModelServeRow } from "../../shared/ipc-contract.js";
import { deriveSystemHealthView } from "../ide/health/health-panel-view.js";
import { useTabsStore } from "../ide/state/stores.js";
import { qk } from "../query/client.js";
import { PrometheusMark } from "../shell/PrometheusMark.js";
import { useEngineStore } from "../stores/engine.js";
import { useSecurityStore } from "../stores/features.js";
import { ageLabel, useRecentsStore } from "../stores/recents.js";
import { useTelemetryStore } from "../stores/telemetry.js";
import { serverRowViews } from "./home-servers-view.js";

function api(): Window["prometheus"] | undefined {
  return typeof window !== "undefined" ? window.prometheus : undefined;
}

/** sessionStorage key the agent rail reads once to seed the prompt typed on Home. */
const HOME_PROMPT_KEY = "prometheus.home.prompt";

export interface HomeRouteProps {
  /** jump to an activity from a card CTA (08 §5.1 buttons). */
  onNavigate(id: ActivityId): void;
  /** open the "Save tokens" bottom-panel toolkit (token-economy proposal CTA). */
  onOpenTokens?(): void;
  /** open the Health bottom panel — the "Run doctor" landing surface (§6 degraded). */
  onOpenHealth?(): void;
}

export function HomeRoute({
  onNavigate,
  onOpenTokens,
  onOpenHealth,
}: HomeRouteProps): ReactElement {
  const savers = tokenEconomy.proposeToolkits().length;
  const pill = useEngineStore((s) => s.pill);
  const health = useEngineStore((s) => s.health);
  const refreshHealth = useEngineStore((s) => s.refreshHealth);
  const refreshing = useEngineStore((s) => s.refreshing);
  const lastVerdict = useSecurityStore((s) => s.lastVerdict);
  const setWorkspaceRoot = useTabsStore((s) => s.setWorkspaceRoot);
  const recents = useRecentsStore((s) => s.recents);
  // READ ONLY — App owns the single telemetry poll loop; a second one here would
  // double the IPC rate for the same numbers.
  const telemetry = useTelemetryStore((s) => s.telemetry);
  const refreshTelemetry = useTelemetryStore((s) => s.refresh);

  const [draft, setDraft] = useState("");

  // ── reads (graceful: enabled only when the bridge exists) ─────────────────
  const hasBridge = api() !== undefined;
  const catalog = useQuery({
    queryKey: qk.catalog(),
    queryFn: () => api()!.list(),
    enabled: hasBridge,
  });
  const envs = useQuery({
    queryKey: qk.envs(),
    queryFn: () => api()!.envList(),
    enabled: hasBridge,
  });
  const serving = useQuery({
    queryKey: qk.homeServers(),
    queryFn: () => api()!.servers(),
    enabled: hasBridge,
  });
  const repos = useQuery({
    queryKey: qk.repos(),
    queryFn: () => api()!.repo.list(),
    enabled: hasBridge,
  });
  // the Models island reads the MODEL supervisor, which is a different payload shape
  // from `servers()` — query/client.ts documents that these two must not share a key.
  const models = useQuery({
    queryKey: qk.modelServing(),
    queryFn: () => api()!.models.serving(),
    enabled: hasBridge,
  });

  const shield = deriveShield(lastVerdict?.verdict ?? null);
  const engineDown = pill === "down";
  // count only RUNNING servers — the snapshot includes stopped/errored, so a bare
  // `.length` would report "3 serving" for 3 stopped servers (a status lie).
  const servingCount = serving.data?.ok
    ? (serving.data.servers ?? []).filter((s) => s?.state === "running").length
    : 0;
  const serverRows = serverRowViews(serving.data);
  const healthView = useMemo(() => deriveSystemHealthView(health, pill), [health, pill]);

  // ── server start/stop (APP-008) — the C8 supervisor over the existing IPC ──
  // One shared mutation; `variables.id` scopes the in-flight disable to ITS row.
  // An ok:false envelope RESOLVES (never hits onError) → surfaced from onSuccess;
  // status truth always comes from the invalidated re-read, never optimistic.
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<{ id: string; error: string } | null>(null);
  const serverAction = useMutation({
    mutationFn: (vars: { id: string; op: "start" | "stop" }) => {
      const bridge = api();
      if (!bridge) return Promise.reject(new Error("bridge unavailable"));
      return vars.op === "start" ? bridge.startServer(vars.id) : bridge.stopServer(vars.id);
    },
    onSuccess: (res, vars) => {
      // e.g. the engine-side 90% CPU/RAM launch guard refusal — shown, NOT retried.
      if (!res?.ok) setServerError({ id: vars.id, error: res?.error ?? `${vars.op} failed` });
      else setServerError(null);
    },
    onError: (e, vars) =>
      setServerError({ id: vars.id, error: e instanceof Error ? e.message : String(e) }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.homeServers() }),
  });
  const inflightServerId = serverAction.isPending ? (serverAction.variables?.id ?? null) : null;
  const catalogRows = catalog.data?.ok ? rowsFrom(catalog.data.data) : [];
  const envCount = envs.data?.ok ? rowsFrom(envs.data.data).length : 0;

  /** Cloned repos + picker-opened folders, newest first, de-duplicated by path. */
  const recentProjects = useMemo(() => {
    const cloned = repos.data?.ok ? (repos.data.repos ?? []) : [];
    const seen = new Set(recents.map((r) => r.path));
    const fromRepos = cloned
      .filter((r) => r?.localPath && !seen.has(r.localPath))
      .map((r) => ({
        path: r.localPath,
        name: r.name || r.localPath,
        openedAt: r.lastFetched ? Date.parse(r.lastFetched) : 0,
      }))
      .filter((r) => Number.isFinite(r.openedAt));
    return [...recents, ...fromRepos].slice(0, 8);
  }, [recents, repos.data]);

  // ── actions ───────────────────────────────────────────────────────────────
  const openFolder = useCallback(async () => {
    const bridge = api();
    if (!bridge?.folderOpen) {
      onNavigate("editor");
      return;
    }
    try {
      const r = await bridge.folderOpen({ title: "Open a project folder" });
      if (r.ok && r.path) {
        setWorkspaceRoot(r.path);
        onNavigate("editor");
      }
    } catch {
      onNavigate("editor"); // picker unavailable — still get the user to the editor.
    }
  }, [onNavigate, setWorkspaceRoot]);

  const openRecent = useCallback(
    (localPath: string) => {
      setWorkspaceRoot(localPath);
      onNavigate("editor");
    },
    [onNavigate, setWorkspaceRoot],
  );

  const askAI = useCallback(() => {
    const text = draft.trim();
    try {
      if (text) sessionStorage.setItem(HOME_PROMPT_KEY, text);
    } catch {
      /* sessionStorage blocked — the rail still opens, just without the seed */
    }
    // §2.3.2: the ask bar routes to the CHAT RAIL with the draft — the rail is always
    // present, so this opens it in place rather than navigating away from Home.
    window.dispatchEvent(new CustomEvent("prometheus:open-agent", { detail: { prompt: text } }));
    setDraft("");
  }, [draft]);

  const runDoctor = useCallback(() => {
    void refreshHealth();
    onOpenHealth?.();
  }, [refreshHealth, onOpenHealth]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 18,
        maxWidth: 1180,
        width: "100%",
        margin: "0 auto",
        padding: "26px 30px 30px",
      }}
    >
      {/* ── 1. greeting + live chips ─────────────────────────────────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          {/* §8.2: the brand mark sits with the greeting — the Home hero is one of the
              surfaces §8 names, and a mission-control screen with no mark reads unbranded. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <PrometheusMark height={26} />
            <div
              style={{
                fontFamily: "var(--font-brand)",
                fontSize: 24,
                fontWeight: 700,
                letterSpacing: "-0.01em",
                color: "var(--text-strong)",
              }}
            >
              {greeting()}
            </div>
          </div>
          <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 13 }}>
            Your AI coding workspace — every install gated by nemesis, fail-closed.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <Chip
            tone={shield.role === "ok" ? "--ok" : shield.role === "warn" ? "--warn" : "--danger"}
            label={`gate ${shield.label}`}
          />
          <Chip tone={enginePillVar(pill)} label={`engine ${pill}`} />
        </div>
      </header>

      {/* ── 2. ask bar ───────────────────────────────────────────────────── */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          askAI();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          height: 52,
          padding: "0 8px 0 18px",
          borderRadius: "var(--radius-xl)",
          background: "var(--bg-surface-2)",
          border: "1px solid var(--border-strong)",
          boxShadow: "var(--elevation-e2)",
        }}
      >
        <SparkGlyph />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask Prometheus to build, refactor, explain, or scan…"
          aria-label="Ask Prometheus"
          style={{
            flex: 1,
            background: "transparent",
            border: 0,
            outline: 0,
            color: "var(--text-primary)",
            fontFamily: "inherit",
            fontSize: 14,
          }}
        />
        <button type="submit" style={gradientCta()}>
          Ask AI <span style={{ fontSize: 15 }}>→</span>
        </button>
      </form>

      {/* ── 3. quick actions ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 10,
        }}
      >
        <QuickAction
          icon="FolderOpen"
          tone="--accent"
          title="Open folder"
          sub="Edit a project with AI"
          onClick={() => void openFolder()}
        />
        <QuickAction
          icon="GitBranch"
          tone="--brand-3"
          title="Clone a repo"
          sub="Staged + nemesis-gated"
          onClick={() => {
            // handoff_3 §1: Repos is a Workspace SEGMENT now. Ask for the segment first,
            // then navigate — the route reads the latch in its initial state, so doing it
            // the other way round lands on Workspace's default instead.
            requestRouteTab("workspace", "repos");
            onNavigate("workspace");
          }}
        />
        <QuickAction
          icon="LayoutGrid"
          tone="--brand-2"
          title="Browse catalog"
          sub="Scanned before install"
          onClick={() => onNavigate("catalog")}
        />
        <QuickAction
          icon="Boxes"
          tone="--ok"
          title="Model hub"
          sub="Local, HF, or cloud"
          onClick={() => onNavigate("models")}
        />
      </div>

      {/* ── 4. islands grid ──────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))",
          gap: 12,
          alignItems: "start",
        }}
      >
        {/* System health — the three real rows + CPU/RAM + Re-check */}
        <Island
          title="System health"
          right={
            <span style={{ color: healthView.tier === "ok" ? "var(--ok)" : "var(--warn)" }}>
              {healthView.summary}
            </span>
          }
        >
          {healthView.components.length === 0 ? (
            <IslandEmpty glyph="🩺" line="No health data yet." />
          ) : (
            healthView.components.map((c) => (
              <IslandRow key={c.id} title={c.remediation ?? c.detail ?? c.status}>
                <Dot tone={`--${healthStatusRole(c.status)}`} />
                <Mono>{c.id}</Mono>
                {c.detail && (
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.detail}
                  </span>
                )}
                <span style={{ flex: 1, minWidth: 8 }} />
                <span
                  style={{
                    fontSize: 11.5,
                    color: `var(--${healthStatusRole(c.status)})`,
                    // one line, ellipsised — the full remediation is in the row's title.
                    minWidth: 0,
                    maxWidth: "55%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {healthStatusGlyph(c.status)} {c.remediation ?? c.status}
                </span>
              </IslandRow>
            ))
          )}
          <div
            style={{
              display: "flex",
              gap: 14,
              alignItems: "center",
              padding: "10px 14px",
              borderTop: "1px solid var(--border-header)",
              background: "var(--bg-inset)",
            }}
          >
            <MeterBar label="CPU" pct={telemetry?.cpu?.usedPct ?? null} tone="--ok" />
            <MeterBar label="RAM" pct={telemetry?.ram?.usedPct ?? null} tone="--warn" />
            <button
              type="button"
              onClick={() => {
                void refreshHealth();
                void refreshTelemetry();
              }}
              disabled={refreshing}
              style={linkButton()}
            >
              {refreshing ? "Checking…" : "Re-check"}
            </button>
          </div>
        </Island>

        {/* Last gate verdict — the §4 card contract, compact */}
        <Island
          title="Last gate verdict"
          right={
            lastVerdict?.scannedAt ? (
              <span>{ageLabel(Date.parse(lastVerdict.scannedAt))} ago</span>
            ) : null
          }
        >
          {!lastVerdict ? (
            <IslandEmpty
              glyph="🛡"
              line="Nothing scanned yet. The gate runs before any install."
              actionLabel="Open Security"
              onAction={() => onNavigate("security")}
            />
          ) : (
            /* §4: the SAME card the catalog, the security console and the chat render —
               one verdict, one shape, wherever you meet it. */
            <VerdictCard
              verdict={lastVerdict.verdict}
              artifact={lastVerdict.target}
              sourceKind={lastVerdict.signed ? "signed" : "unsigned"}
              riskScore={lastVerdict.riskScore}
              findings={findingsOf(lastVerdict)}
              onDetails={() => onNavigate("security")}
            />
          )}
        </Island>

        {/* Models — serving/installed, with the §6 DEGRADED state when the engine is out */}
        <Island
          title="Models"
          right={
            <span>
              {engineDown
                ? "last known · stale"
                : `${servingCount} serving · ${catalogRows.length} in catalog`}
            </span>
          }
        >
          {engineDown ? (
            <IslandDegraded
              error={health?.error ?? "the engine did not answer the health probe"}
              onRunDoctor={runDoctor}
            />
          ) : models.isLoading ? (
            <IslandSkeleton rows={2} />
          ) : !models.data?.ok ? (
            <IslandDegraded
              error={models.data?.error ?? "the model supervisor did not answer"}
              onRunDoctor={runDoctor}
            />
          ) : (models.data.profiles ?? []).length === 0 ? (
            <IslandEmpty
              glyph="◴"
              line="No model installed yet."
              actionLabel="Open Model hub"
              onAction={() => onNavigate("models")}
            />
          ) : (
            (models.data.profiles ?? []).map((p: ModelServeRow) => {
              const ready = p.status === "ready";
              return (
                <IslandRow key={p.id ?? p.modelId}>
                  <Dot tone={ready ? "--ok" : "--text-disabled"} />
                  <Mono>{p.modelId}</Mono>
                  <span style={{ flex: 1 }} />
                  <span
                    style={{
                      fontSize: 11,
                      color: ready ? "var(--ok)" : "var(--text-disabled)",
                    }}
                  >
                    {ready ? "serving" : (p.status ?? "installed")}
                  </span>
                </IslandRow>
              );
            })
          )}
        </Island>

        {/* Recent projects */}
        <Island
          title="Recent projects"
          right={
            <button type="button" onClick={() => void openFolder()} style={linkButton()}>
              Open folder…
            </button>
          }
        >
          {repos.isLoading && recentProjects.length === 0 ? (
            <IslandSkeleton rows={3} />
          ) : recentProjects.length === 0 ? (
            <IslandEmpty
              glyph="📁"
              line="No projects yet. Open a folder or clone a repo to get started."
              actionLabel="Open folder"
              onAction={() => void openFolder()}
            />
          ) : (
            recentProjects.map((r) => (
              <IslandRow key={r.path} onClick={() => openRecent(r.path)} title={r.path}>
                <span style={glyphChip()}>{(r.name[0] ?? "?").toUpperCase()}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span
                    style={{
                      display: "block",
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      fontSize: 12.5,
                    }}
                  >
                    {r.name}
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: "var(--text-disabled)",
                      fontFamily: "var(--font-mono)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {r.path}
                  </span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {r.openedAt > 0 ? ageLabel(r.openedAt) : "—"}
                </span>
              </IslandRow>
            ))
          )}
        </Island>

        {/* Servers (APP-008) — the C8 supervisor's Start/Stop. Renders ONLY when the
            supervisor reports rows: §2.3 "nothing renders unless it has content". */}
        {hasBridge && serverRows.length > 0 && (
          <Island title="Servers" right={<span>{servingCount} running</span>}>
            {serverRows.map((s) => {
              const busy = inflightServerId === s.id;
              const rowError = serverError?.id === s.id ? serverError.error : (s.lastError ?? null);
              return (
                <div key={s.id}>
                  <IslandRow title={s.id}>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 12.5,
                      }}
                    >
                      {s.label}
                    </span>
                    <StatusPill status={s.pill} label={busy ? "…" : s.state} />
                    {s.op && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          serverAction.mutate({ id: s.id, op: s.op as "start" | "stop" })
                        }
                        style={{
                          ...secondaryBtn(),
                          padding: "2px 10px",
                          fontSize: 11.5,
                          borderColor: s.op === "start" ? "var(--ok)" : "var(--danger)",
                          color: s.op === "start" ? "var(--ok)" : "var(--danger-fg)",
                          opacity: busy ? 0.6 : 1,
                        }}
                      >
                        {s.op === "start" ? "Start" : "Stop"}
                      </button>
                    )}
                  </IslandRow>
                  {rowError && (
                    <div
                      role="alert"
                      style={{
                        color: "var(--danger-fg)",
                        fontSize: 11.5,
                        padding: "0 14px 8px 36px",
                      }}
                    >
                      {rowError}
                    </div>
                  )}
                </div>
              );
            })}
          </Island>
        )}

        {/* At a glance — the counts that don't warrant their own island */}
        <Island title="At a glance">
          <IslandRow>
            <span style={{ flex: 1, fontSize: 12.5 }}>Environments</span>
            <Mono>{envCount}</Mono>
          </IslandRow>
          <IslandRow>
            <span style={{ flex: 1, fontSize: 12.5 }}>Catalog items</span>
            <Mono>{catalogRows.length}</Mono>
          </IslandRow>
          {onOpenTokens && savers > 0 && (
            <IslandRow onClick={onOpenTokens}>
              <span style={{ flex: 1, fontSize: 12.5 }}>Save tokens</span>
              <span style={{ color: "var(--accent)", fontSize: 12 }}>{savers} proposed →</span>
            </IslandRow>
          )}
        </Island>
      </div>
    </div>
  );
}

/* ── island chrome (handoff §2.3.4 / §2) ──────────────────────────────────── */

/** The island shell: 14px radius, surface fill, subtle border, header separator. */
function Island({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section
      style={{
        borderRadius: "var(--radius-xl)",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "11px 14px",
          borderBottom: "1px solid var(--border-header)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-brand)",
            fontWeight: 600,
            fontSize: 13,
            color: "var(--text-title)",
          }}
        >
          {title}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{right}</span>
      </header>
      <div style={{ display: "flex", flexDirection: "column" }}>{children}</div>
    </section>
  );
}

/** One island row — a click handler promotes it to a real button. */
function IslandRow({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
}): ReactElement {
  const [hover, setHover] = useState(false);
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    width: "100%",
    padding: "9px 14px",
    borderBottom: "1px solid var(--border-row)",
    background: onClick && hover ? "var(--bg-surface-2)" : "transparent",
    border: "none",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: "var(--border-row)",
    color: "var(--text-secondary)",
    textAlign: "left",
    font: "inherit",
    cursor: onClick ? "pointer" : "default",
  };
  if (!onClick) return <div style={style}>{children}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={style}
    >
      {children}
    </button>
  );
}

/** §6 EMPTY: a glyph, one sentence, and (optionally) the primary action. */
function IslandEmpty({
  glyph,
  line,
  actionLabel,
  onAction,
}: {
  glyph: string;
  line: string;
  actionLabel?: string;
  onAction?: () => void;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: "22px 16px",
        textAlign: "center",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 20, opacity: 0.5 }}>
        {glyph}
      </span>
      <span style={{ color: "var(--text-body)", fontSize: 12.5 }}>{line}</span>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} style={{ ...secondaryBtn(), marginTop: 2 }}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/**
 * §6 DEGRADED: the engine (or a supervisor) is unreachable. Show WHY in the engine's
 * own words + the one action that can fix it. Never blank, never a crash.
 */
function IslandDegraded({
  error,
  onRunDoctor,
}: {
  error: string;
  onRunDoctor: () => void;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: "22px 16px",
        textAlign: "center",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 20, opacity: 0.5 }}>
        ◔
      </span>
      <span style={{ color: "var(--text-body)", fontSize: 12.5 }}>
        Engine unreachable — showing last known state.
      </span>
      <span
        style={{
          color: "var(--text-disabled)",
          fontSize: 11.5,
          fontFamily: "var(--font-mono)",
          // engine errors carry absolute paths — break them inside the island rather
          // than letting one long token blow the card's width out.
          maxWidth: "100%",
          overflowWrap: "break-word",
          wordBreak: "break-word",
        }}
      >
        {error}
      </span>
      <button type="button" onClick={onRunDoctor} style={{ ...secondaryBtn(), marginTop: 2 }}>
        Run doctor
      </button>
    </div>
  );
}

/** §6 LOADING: skeleton rows, so the island keeps its shape while data arrives. */
function IslandSkeleton({ rows }: { rows: number }): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {Array.from({ length: rows }, (_, i) => `sk-${i}`).map((id) => (
        <div
          key={id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "11px 14px",
            borderBottom: "1px solid var(--border-row)",
          }}
        >
          <span
            className="prom-skeleton"
            style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--bg-active)" }}
          />
          <span
            className="prom-skeleton"
            style={{
              height: 9,
              flex: 1,
              maxWidth: 160,
              borderRadius: 4,
              background: "var(--bg-active)",
            }}
          />
        </div>
      ))}
    </div>
  );
}

/* ── small presentational helpers ─────────────────────────────────────────── */

function QuickAction({
  icon,
  tone,
  title,
  sub,
  onClick,
}: {
  icon: string;
  tone: string;
  title: string;
  sub: string;
  onClick: () => void;
}): ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "13px 14px",
        borderRadius: "var(--radius-island)",
        background: hover ? "var(--bg-surface-2)" : "var(--bg-surface)",
        border: `1px solid ${hover ? "var(--border-hover)" : "var(--border-subtle)"}`,
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "var(--font-ui)",
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 34,
          height: 34,
          flex: "none",
          borderRadius: 9,
          background: `color-mix(in srgb, var(${tone}) 12%, transparent)`,
          color: `var(${tone})`,
        }}
      >
        <ActivityIcon name={icon} size={16} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{ display: "block", fontWeight: 600, color: "var(--text-primary)", fontSize: 13 }}
        >
          {title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 11.5,
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {sub}
        </span>
      </span>
    </button>
  );
}

/** A CPU/RAM occupancy bar with the gradient fill (§2.3.4). `null` = not measured. */
function MeterBar({
  label,
  pct,
  tone,
}: {
  label: string;
  pct: number | null;
  tone: string;
}): ReactElement {
  const measured = typeof pct === "number" && Number.isFinite(pct);
  const width = measured ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 7, flex: 1 }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)", width: 28 }}>{label}</span>
      <span
        style={{
          flex: 1,
          height: 5,
          borderRadius: 3,
          background: "var(--bg-active)",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            width: `${width}%`,
            borderRadius: 3,
            background: `linear-gradient(90deg, var(--accent), var(${tone}))`,
          }}
        />
      </span>
      <span
        style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)" }}
      >
        {measured ? `${Math.round(width)}%` : "—"}
      </span>
    </span>
  );
}

function Chip({ tone, label }: { tone: string; label: string }): ReactElement {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <Dot tone={tone} size={6} />
      {label}
    </span>
  );
}

function Dot({ tone, size = 8 }: { tone: string; size?: number }): ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flex: "none",
        background: `var(${tone})`,
      }}
    />
  );
}

function Mono({ children, size = 12 }: { children: ReactNode; size?: number }): ReactElement {
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: size, color: "var(--text-primary)" }}>
      {children}
    </span>
  );
}

function SparkGlyph(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7L12 3Z"
        fill="var(--accent)"
      />
      <path
        d="M18.5 14.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z"
        fill="var(--brand-2)"
      />
    </svg>
  );
}

function glyphChip(): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    flex: "none",
    borderRadius: 8,
    background: "color-mix(in srgb, var(--accent) 12%, transparent)",
    color: "var(--accent)",
    fontWeight: 700,
    fontSize: 12,
  };
}

function gradientCta(): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 7,
    height: 36,
    padding: "0 18px",
    borderRadius: "var(--radius-lg)",
    border: "none",
    background: "var(--gradient-brand)",
    color: "var(--brand-fg)",
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function secondaryBtn(): CSSProperties {
  return {
    padding: "6px 13px",
    borderRadius: "var(--radius-lg)",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    color: "var(--text-title)",
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function linkButton(): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "var(--accent)",
    fontFamily: "var(--font-ui)",
    fontSize: 11.5,
    cursor: "pointer",
    padding: 0,
  };
}

function enginePillVar(pill: string): string {
  return pill === "ready" ? "--ok" : pill === "down" ? "--danger" : "--warn";
}

/**
 * The gate result's findings in the §4 card's shape. `detail` is optional on the
 * envelope (the engine omits it for a clean scan), and its `findings` array is guarded
 * before mapping — an envelope shape change must degrade to "no rows", never a crash.
 */
function findingsOf(v: GateResult): VerdictCardFinding[] {
  const raw = v.detail?.findings;
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => ({
    rule: f.rule,
    description: f.klass,
    where: f.where,
    severity: f.severity,
  }));
}

/** Coerce an engine envelope's `data` into an array of rows (key-probing, fail-soft). */
function rowsFrom(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    for (const key of ["items", "rows", "apps", "envs", "list"]) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

/** Time-of-day greeting (local clock). */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up?";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default HomeRoute;
