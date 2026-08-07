/**
 * routes/home.tsx — the Home / Welcome screen (file 08 §5.1), reworked into an
 * IDE-grade AI launcher (the JetBrains/Cursor "welcome" feel).
 *
 * The first surface after launch is now a LAUNCHER, not a passive dashboard:
 *   1. a brand hero + ambient engine/shield line,
 *   2. an AI prompt bar (the centerpiece — type an intent, jump straight to Chat
 *      with the draft seeded via sessionStorage),
 *   3. big primary actions (Open folder · Ask AI · Clone repo · Browse skills),
 *   4. a "Recent projects" column fed by repo.list() (click → open in the editor),
 *   5. a compact "At a glance" status strip (Security/Models/Env/Catalog/Tokens),
 *      demoted from hero cards so the screen reads as AI-coding-forward.
 *
 * Every read DEGRADES GRACEFULLY: a failed/pending engine read renders a calm
 * placeholder, never a white screen (C5 spirit). The folder picker + workspace
 * handoff go through `window.prometheus.folderOpen` + the editor tabs store.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + TanStack Query + the renderer
 * stores + window.prometheus only. No node/electron/engine-bridge.
 */

import * as tokenEconomy from "@prometheus/core/token-economy";
import {
  ActivityIcon,
  type ActivityId,
  StatusPill,
  VerdictBadge,
  deriveShield,
} from "@prometheus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useCallback,
  useState,
} from "react";

import { useTabsStore } from "../ide/state/stores.js";
import { qk } from "../query/client.js";
import { useEngineStore } from "../stores/engine.js";
import { useSecurityStore } from "../stores/features.js";
import { serverRowViews } from "./home-servers-view.js";

function api(): Window["prometheus"] | undefined {
  return typeof window !== "undefined" ? window.prometheus : undefined;
}

/** sessionStorage key the Chat route reads once to seed the prompt typed on Home. */
const HOME_PROMPT_KEY = "prometheus.home.prompt";

export interface HomeRouteProps {
  /** jump to an activity from a card CTA (08 §5.1 buttons). */
  onNavigate(id: ActivityId): void;
  /** open the "Save tokens" bottom-panel toolkit (token-economy proposal CTA). */
  onOpenTokens?(): void;
}

export function HomeRoute({ onNavigate, onOpenTokens }: HomeRouteProps): ReactElement {
  const savers = tokenEconomy.proposeToolkits().length;
  const pill = useEngineStore((s) => s.pill);
  const lastVerdict = useSecurityStore((s) => s.lastVerdict);
  const setWorkspaceRoot = useTabsStore((s) => s.setWorkspaceRoot);

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

  const shield = deriveShield(lastVerdict?.verdict ?? null);
  // count only RUNNING servers — the snapshot includes stopped/errored, so the old
  // `.length` reported "3 serving" for 3 stopped servers (a status lie on the launcher).
  const servingCount = serving.data?.ok
    ? (serving.data.servers ?? []).filter((s) => s?.state === "running").length
    : 0;
  const serverRows = serverRowViews(serving.data);

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
  const recent = repos.data?.ok ? (repos.data.repos ?? []) : [];

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
      /* sessionStorage blocked — Chat still opens, just without the seed */
    }
    onNavigate("chat");
  }, [draft, onNavigate]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-12, 24px)",
        maxWidth: 1180,
        width: "100%",
        margin: "0 auto",
      }}
    >
      {/* ── hero ── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: "var(--space-8, 16px)",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--space-4, 12px)" }}>
            <PrometheusMark height={60} />
            <h1 style={wordmark()}>Prometheus</h1>
          </div>
          <p
            style={{
              margin: "8px 0 0",
              color: "var(--text-primary)",
              fontFamily: "var(--font-brand)",
              fontWeight: 600,
              fontSize: "1.06rem",
              letterSpacing: "-0.005em",
            }}
          >
            {greeting()} Your AI coding workspace — secure by default.
          </p>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-6, 12px)",
            fontSize: "0.82rem",
          }}
        >
          <StatusDot
            role={pill === "ready" ? "ok" : pill === "down" ? "danger" : "warn"}
            label={`engine ${pill}`}
          />
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: "var(--text-secondary)",
            }}
          >
            <span style={{ color: shieldColor(shield.role) }}>{shield.glyph}</span>
            {shield.label}
          </span>
        </div>
      </div>

      {/* ── AI prompt bar (the centerpiece) ── */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          askAI();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4, 8px)",
          padding:
            "var(--space-3, 6px) var(--space-3, 6px) var(--space-3, 6px) var(--space-6, 12px)",
          background: "var(--bg-surface-2)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-xl, 14px)",
          boxShadow: "var(--elevation-e1)",
        }}
      >
        <span
          aria-hidden="true"
          style={{ color: "var(--accent)", fontSize: "1.05rem", lineHeight: 1 }}
        >
          ✦
        </span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask Prometheus to build, explain, refactor, or scan…"
          aria-label="Ask the AI"
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--text-primary)",
            fontFamily: "var(--font-ui)",
            fontSize: "0.95rem",
            padding: "8px 0",
          }}
        />
        <button type="submit" style={primaryBtn()}>
          Ask AI →
        </button>
      </form>

      {/* ── primary launcher cards ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "var(--space-6, 12px)",
        }}
      >
        <LaunchCard
          icon="Code2"
          title="Open folder"
          subtitle="Edit a project with AI"
          onClick={() => void openFolder()}
          accent
        />
        <LaunchCard
          icon="MessageSquare"
          title="Chat with AI"
          subtitle="Local model or paid CLI"
          onClick={() => onNavigate("chat")}
        />
        <LaunchCard
          icon="GitBranch"
          title="Clone a repo"
          subtitle="Gated before it lands"
          onClick={() => onNavigate("repos")}
        />
        <LaunchCard
          icon="LayoutGrid"
          title="Browse skills"
          subtitle="Scanned-before-install catalog"
          onClick={() => onNavigate("catalog")}
        />
        <LaunchCard
          icon="Settings"
          title="Run setup wizard"
          subtitle="Interpreter · model · theme · tokens"
          onClick={() => window.dispatchEvent(new CustomEvent("prometheus:run-onboarding"))}
        />
      </div>

      {/* ── recent projects + at-a-glance status ── */}
      <div
        style={{
          display: "flex",
          gap: "var(--space-8, 16px)",
          flexWrap: "wrap",
          alignItems: "flex-start",
        }}
      >
        <section style={{ flex: "2 1 360px", minWidth: 0 }}>
          <SectionTitle>Recent projects</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {repos.isLoading ? (
              <Hint>Loading…</Hint>
            ) : recent.length === 0 ? (
              <Hint>No recent projects. Open a folder or clone a repo to get started.</Hint>
            ) : (
              recent
                .slice(0, 8)
                .map((r) => (
                  <RecentProject
                    key={r.id}
                    name={r.name}
                    sub={`${r.owner}${r.branch ? ` · ${r.branch}` : ""}`}
                    status={r.status}
                    onClick={() => openRecent(r.localPath)}
                  />
                ))
            )}
          </div>
        </section>

        <section style={{ flex: "1 1 240px", minWidth: 0 }}>
          <SectionTitle>At a glance</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <GlanceRow
              label="Security"
              onClick={() => onNavigate("security")}
              value={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <VerdictBadge
                    verdict={lastVerdict?.verdict ?? "allow"}
                    risk_score={lastVerdict?.riskScore}
                    compact
                  />
                  <span style={{ color: "var(--text-secondary)" }}>
                    {lastVerdict ? `rs ${lastVerdict.riskScore}` : "no scans"}
                  </span>
                </span>
              }
            />
            <GlanceRow
              label="Models"
              onClick={() => onNavigate("models")}
              value={<Mono>{serving.isLoading ? "…" : `${servingCount} serving`}</Mono>}
            />
            <GlanceRow
              label="Environments"
              onClick={() => onNavigate("environments")}
              value={<Mono>{envs.isLoading ? "…" : `${envCount}`}</Mono>}
            />
            <GlanceRow
              label="Catalog"
              onClick={() => onNavigate("catalog")}
              value={<Mono>{catalog.isLoading ? "…" : `${catalogRows.length}`}</Mono>}
            />
            {onOpenTokens && (
              <GlanceRow
                label="Save tokens"
                onClick={onOpenTokens}
                value={
                  <span style={{ color: "var(--accent)", fontSize: "0.82rem" }}>
                    {savers} proposed →
                  </span>
                }
              />
            )}
          </div>

          {/* supervised servers (APP-008): live rows with Start/Stop over the C8
              supervisor IPC. Status is the refetched servers() read, never optimistic;
              a transitioning row (stopping) offers no action until the re-read. */}
          {hasBridge && serverRows.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <SectionTitle>Servers</SectionTitle>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {serverRows.map((s) => {
                  const busy = inflightServerId === s.id;
                  const rowError =
                    serverError?.id === s.id ? serverError.error : (s.lastError ?? null);
                  return (
                    <div key={s.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "4px 8px",
                          borderRadius: "var(--radius-md, 6px)",
                          background: "var(--bg-surface)",
                          border: "1px solid var(--border-subtle)",
                        }}
                      >
                        <span
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontSize: "0.82rem",
                          }}
                          title={s.id}
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
                              background:
                                s.op === "start"
                                  ? "color-mix(in srgb, var(--ok) 16%, transparent)"
                                  : "color-mix(in srgb, var(--danger) 14%, transparent)",
                              border: `1px solid ${s.op === "start" ? "var(--ok)" : "var(--danger)"}`,
                              borderRadius: "var(--radius-md, 6px)",
                              color: "var(--text-primary)",
                              cursor: busy ? "default" : "pointer",
                              fontSize: "0.75rem",
                              padding: "1px 8px",
                              opacity: busy ? 0.6 : 1,
                            }}
                          >
                            {s.op === "start" ? "Start" : "Stop"}
                          </button>
                        )}
                      </div>
                      {rowError && (
                        <div
                          role="alert"
                          style={{ color: "var(--danger)", fontSize: "0.72rem", paddingLeft: 8 }}
                        >
                          {rowError}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ── presentational helpers (token-styled) ───────────────────────────────── */

function LaunchCard({
  icon,
  title,
  subtitle,
  onClick,
  accent,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onClick: () => void;
  accent?: boolean;
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
        gap: "var(--space-4, 8px)",
        textAlign: "left",
        padding: "var(--space-6, 12px) var(--space-6, 14px)",
        background: hover ? "var(--bg-surface-2)" : "var(--bg-surface)",
        border: `1px solid ${hover ? "var(--border-strong)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius-lg, 12px)",
        color: "var(--text-primary)",
        cursor: "pointer",
        transition: "background 120ms ease, border-color 120ms ease, transform 120ms ease",
        transform: hover ? "translateY(-1px)" : "translateY(0)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 38,
          height: 38,
          flexShrink: 0,
          borderRadius: "var(--radius-md, 8px)",
          background: accent
            ? "color-mix(in srgb, var(--brand) 16%, transparent)"
            : "var(--bg-inset)",
          color: accent ? "var(--brand)" : "var(--text-secondary)",
        }}
      >
        <ActivityIcon name={icon} size={20} active={accent} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ fontSize: "0.92rem", fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>{subtitle}</span>
      </span>
    </button>
  );
}

function RecentProject({
  name,
  sub,
  status,
  onClick,
}: {
  name: string;
  sub: string;
  status: string;
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
        gap: "var(--space-4, 8px)",
        width: "100%",
        textAlign: "left",
        padding: "var(--space-3, 7px) var(--space-4, 10px)",
        background: hover ? "var(--bg-surface-2)" : "transparent",
        border: "none",
        borderRadius: "var(--radius-md, 6px)",
        cursor: "pointer",
        color: "var(--text-primary)",
      }}
    >
      <span aria-hidden="true" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
        <ActivityIcon name="Code2" size={16} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
        <span
          style={{
            fontSize: "0.86rem",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontSize: "0.74rem",
            color: "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {sub}
        </span>
      </span>
      <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)", flexShrink: 0 }}>
        {status}
      </span>
    </button>
  );
}

function GlanceRow({
  label,
  value,
  onClick,
}: { label: string; value: ReactNode; onClick: () => void }): ReactElement {
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
        justifyContent: "space-between",
        gap: "var(--space-4, 8px)",
        width: "100%",
        padding: "var(--space-3, 7px) var(--space-4, 10px)",
        background: hover ? "var(--bg-surface-2)" : "transparent",
        border: "none",
        borderRadius: "var(--radius-md, 6px)",
        cursor: "pointer",
        color: "var(--text-primary)",
        fontSize: "0.85rem",
      }}
    >
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ display: "inline-flex", alignItems: "center" }}>{value}</span>
    </button>
  );
}

function SectionTitle({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      style={{
        fontSize: "var(--text-small-size, 0.8125rem)",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: "var(--text-secondary)",
        margin: "0 0 var(--space-3, 6px)",
        paddingInline: "var(--space-4, 10px)",
      }}
    >
      {children}
    </div>
  );
}

function StatusDot({
  role,
  label,
}: { role: "ok" | "warn" | "danger"; label: string }): ReactElement {
  const color = role === "ok" ? "var(--ok)" : role === "danger" ? "var(--danger)" : "var(--warn)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: "var(--text-secondary)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 6px ${color}`,
        }}
      />
      {label}
    </span>
  );
}

function Hint({ children }: { children: ReactNode }): ReactElement {
  return (
    <p
      style={{
        margin: 0,
        padding: "var(--space-4, 10px)",
        color: "var(--text-secondary)",
        fontSize: "0.82rem",
      }}
    >
      {children}
    </p>
  );
}

function Mono({ children }: { children: ReactNode }): ReactElement {
  return <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>{children}</span>;
}

/** Resolve a deriveShield role token name to a CSS color var. */
function shieldColor(role: string): string {
  return role === "text-secondary" ? "var(--text-secondary)" : `var(--${role})`;
}

function wordmark(): CSSProperties {
  return {
    margin: 0,
    fontFamily: "var(--font-brand, var(--font-ui))",
    fontSize: "2.6rem",
    fontWeight: 900, // Montserrat Black — bold + readable, never thin
    lineHeight: 1.05,
    letterSpacing: "-0.025em",
    background: "linear-gradient(92deg, var(--brand), var(--accent))",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
  };
}

/**
 * The Prometheus mark — an SVG rendition of the CLI's ZEUS·CRONOS Titan
 * (apps/cli/src/session/host.ts): a short, wide, muscular Titan raising a YELLOW
 * LIGHTNING BOLT (the CLI's `Ϟ` — NOT a torch/flame), with cyan arms+pecs+shoulders,
 * a brand-tinted ab band, and blue quads. SVG (not the block-glyph art) so it renders
 * crisp+gap-free regardless of the installed monospace font; theme tokens so it
 * re-tints with the scheme.
 */
function PrometheusMark({ height = 58 }: { height?: number }): ReactElement {
  // The muscular Titan holding a thunderbolt (Ϟ) — ported VERBATIM from the `prometheus` CLI
  // startup banner (apps/cli/src/session/host.ts → ZEUS_ROWS) so desktop and terminal
  // share ONE identity. Rendered as block glyphs in a monospace <pre>, colored per
  // muscle zone: silver hair · yellow bolt · cyan arms/pecs · brand abs · blue quads.
  const HAIR = "var(--text-secondary)";
  const BOLT = "var(--warn)";
  const ARM = "var(--accent)";
  const AB = "var(--brand)";
  const QUAD = "var(--info)";
  const rows: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
    [
      ["        ", HAIR],
      ["Ϟ", BOLT],
    ], // thunderbolt (raised hand)
    [
      ["  ▟▀▀▙  ", HAIR],
      ["▟", ARM],
    ], // head + raised forearm
    [
      [" ██▀▀██", BOLT],
      ["▟▘", ARM],
    ], // face (eyes) + raised arm
    [["▟████████▙", ARM]], // shoulders / traps
    [["███▟█▙▟█▙███", ARM]], // arms + PECTORALS
    [[" █ █▀█▀█ █", AB]], // ABS (six-pack grid)
    [["  ▐██▌██▌", QUAD]], // QUADS (thighs)
  ];
  return (
    <pre
      aria-hidden="true"
      style={{
        margin: 0,
        flexShrink: 0,
        fontFamily: "var(--font-mono)",
        fontSize: `${height / rows.length}px`,
        lineHeight: 1,
        whiteSpace: "pre",
        userSelect: "none",
      }}
    >
      {rows.map((row) => {
        const rowKey = row.map(([g]) => g).join("|");
        return (
          <div key={rowKey}>
            {row.map(([glyphs, color]) => (
              <span key={`${rowKey}:${color}`} style={{ color }}>
                {glyphs}
              </span>
            ))}
          </div>
        );
      })}
    </pre>
  );
}

function primaryBtn(): CSSProperties {
  return {
    flexShrink: 0,
    padding: "9px 16px",
    borderRadius: "var(--radius-lg, 10px)",
    border: "none",
    background: "var(--brand)",
    color: "var(--brand-fg)",
    cursor: "pointer",
    fontSize: "0.88rem",
    fontWeight: 600,
    fontFamily: "var(--font-ui)",
  };
}

/** Best-effort row extraction from an engine envelope's `data` (list/items/rows). */
function rowsFrom(data: Record<string, unknown> | undefined): unknown[] {
  if (!data) return [];
  for (const key of ["items", "rows", "list", "entries", "envs", "plugins"]) {
    const v = data[key];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** A time-of-day greeting (cosmetic). */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning.";
  if (h < 18) return "Good afternoon.";
  return "Good evening.";
}

export default HomeRoute;
