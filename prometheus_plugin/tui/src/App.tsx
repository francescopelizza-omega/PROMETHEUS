// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * App.tsx — Prometheus terminal GUI (Ink).
 *
 * Left pane: operation menu. Right pane: the active view, which fetches from
 * prometheus.py's --json surface via runEngine(). Global keys: q/Ctrl-C quit,
 * Esc back to menu, r refresh the active view.
 */
import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { runEngine } from "./bridge.js";
import { COLOR, VERDICT_COLOR, DOT } from "./theme.js";

type ViewId = "menu" | "scan" | "catalog" | "install" | "audit" | "matrix" | "skills" | "vault";

const MENU: { label: string; value: ViewId }[] = [
  { label: "Scan agents", value: "scan" },
  { label: "Browse catalog", value: "catalog" },
  { label: "Install / dry-run", value: "install" },
  { label: "Security audit", value: "audit" },
  { label: "Reach matrix", value: "matrix" },
  { label: "Skills", value: "skills" },
  { label: "Repo vault", value: "vault" },
];

function useEngine<T = any>(argv: string[] | null) {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: string | null }>({
    loading: false,
    data: null,
    error: null,
  });
  const load = useCallback(() => {
    if (!argv) return;
    setState({ loading: true, data: null, error: null });
    runEngine<T>(argv)
      .then((r) => {
        // an engine error envelope (ok:false) must surface as an error, not an
        // empty view — honor the bridge's computed ok flag.
        if (!r.ok) {
          const msg = (r.data as any)?.error ?? "engine returned an error";
          setState({ loading: false, data: null, error: String(msg) });
        } else {
          setState({ loading: false, data: r.data, error: null });
        }
      })
      .catch((e) => setState({ loading: false, data: null, error: (e as Error).message }));
  }, [JSON.stringify(argv)]);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, reload: load };
}

const Loading = ({ what }: { what: string }) => (
  <Text>
    <Text color={COLOR.accent}>
      <Spinner type="dots" />
    </Text>{" "}
    {what}…
  </Text>
);

const ErrorLine = ({ msg }: { msg: string }) => (
  <Text color={COLOR.err}>error: {msg}</Text>
);

// ---- views ------------------------------------------------------------- //
const ScanView = () => {
  const { loading, data, error } = useEngine(["superscan"]);
  if (loading) return <Loading what="scanning agents" />;
  if (error) return <ErrorLine msg={error} />;
  const agents: any[] = data?.agents ?? [];
  return (
    <Box flexDirection="column">
      <Text bold>Agents ({data?.summary?.active} active · {data?.summary?.forgotten} forgotten · {data?.summary?.total} known)</Text>
      {agents.map((a) => {
        const dot = a.present ? DOT.present : a.forgotten ? DOT.forgotten : DOT.absent;
        const col = a.present ? COLOR.ok : a.forgotten ? COLOR.warn : COLOR.dim;
        const c = a.counts;
        const contents = a.total
          ? `${c.plugins}p ${c.skills}s ${c.mcp}m ${c.extensions}x ${c.rules}r ${c.commands}c`
          : "empty";
        return (
          <Text key={a.name}>
            <Text color={col}>{dot}</Text> {a.name.padEnd(14)}
            <Text color={COLOR.dim}> {String(a.version ?? "").padEnd(10)}</Text> {contents}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text color={COLOR.dim}>
          prereqs: {Object.entries(data?.prereqs ?? {})
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(" ")}
        </Text>
      </Box>
    </Box>
  );
};

const CatalogView = ({ active }: { active: boolean }) => {
  const { loading, data, error } = useEngine(["list"]);
  const [selected, setSelected] = useState<string | null>(null);
  const info = useEngine(selected ? ["info", selected] : null);
  if (loading) return <Loading what="loading catalog" />;
  if (error) return <ErrorLine msg={error} />;
  const items = (data?.catalog ?? []).map((p: any) => ({
    label: `${p.tier[0].toUpperCase()} ${p.name}`,
    value: p.name,
  }));
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={28} marginRight={2}>
        <Text bold>Catalog ({items.length})</Text>
        <SelectInput
          items={items}
          isFocused={active}
          limit={12}
          onHighlight={(i: any) => setSelected(i.value)}
        />
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {selected && info.loading && <Loading what="loading info" />}
        {selected && info.data?.plugin && (
          <Box flexDirection="column">
            <Text bold color={COLOR.brand}>{info.data.plugin.name}</Text>
            <Text>{info.data.plugin.summary}</Text>
            <Text color={COLOR.dim}>
              tier {info.data.plugin.tier} · {info.data.plugin.scope}
              {info.data.plugin.repo ? ` · ${info.data.plugin.repo}` : ""}
            </Text>
            {info.data.plugin.security_note ? (
              <Text color={COLOR.warn}>security: {info.data.plugin.security_note}</Text>
            ) : null}
            <Box marginTop={1} flexDirection="column">
              <Text bold>targets:</Text>
              {Object.entries(info.data.plugin.targets).map(([agent, t]: any) => (
                <Text key={agent}>  {agent} → {t.method}</Text>
              ))}
            </Box>
          </Box>
        )}
        {!selected && <Text color={COLOR.dim}>↑/↓ to browse plugins</Text>}
      </Box>
    </Box>
  );
};

const ActionView = ({ active, kind }: { active: boolean; kind: "install" | "audit" }) => {
  const list = useEngine(["list"]);
  const [target, setTarget] = useState<string | null>(null);
  const [run, setRun] = useState<{ loading: boolean; data: any; error: string | null } | null>(null);

  const doRun = useCallback(
    (name: string) => {
      setRun({ loading: true, data: null, error: null });
      const argv =
        kind === "install" ? ["--dry-run", "install", name] : ["audit", name];
      runEngine(argv)
        .then((r) => setRun({ loading: false, data: r.data, error: null }))
        .catch((e) => setRun({ loading: false, data: null, error: (e as Error).message }));
    },
    [kind],
  );

  if (list.loading) return <Loading what="loading catalog" />;
  const items = (list.data?.catalog ?? []).map((p: any) => ({ label: p.name, value: p.name }));

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={26} marginRight={2}>
        <Text bold>{kind === "install" ? "Install (dry-run)" : "Audit"}</Text>
        <SelectInput
          items={items}
          isFocused={active && !run?.loading}
          limit={12}
          onSelect={(i: any) => {
            setTarget(i.value);
            doRun(i.value);
          }}
          onHighlight={(i: any) => setTarget(i.value)}
        />
        <Text color={COLOR.dim}>enter = run</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {run?.loading && <Loading what={`${kind} ${target}`} />}
        {run?.error && <ErrorLine msg={run.error} />}
        {run?.data && kind === "install" && <InstallResult data={run.data} />}
        {run?.data && kind === "audit" && <AuditResult data={run.data} />}
        {!run && <Text color={COLOR.dim}>pick a plugin, press enter</Text>}
      </Box>
    </Box>
  );
};

const VerdictBadge = ({ verdict }: { verdict: string }) => (
  <Text backgroundColor={VERDICT_COLOR[verdict] ?? "gray"} color="black">
    {" "}
    {String(verdict).toUpperCase()}{" "}
  </Text>
);

const InstallResult = ({ data }: { data: any }) => {
  const events: any[] = data?.results?.install_events ?? [];
  const summary = data?.results?.summary ?? {};
  return (
    <Box flexDirection="column">
      <Text bold>install {data.request?.plugin} (dry-run)</Text>
      {events.map((e, i) => (
        <Text key={i}>
          <Text color={e.result === "blocked" || e.result === "failed" ? COLOR.err : COLOR.ok}>
            {e.result}
          </Text>{" "}
          {e.plugin} → {e.agent} ({e.method})
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={COLOR.dim}>
          {Object.entries(summary).map(([k, v]) => `${k}:${v}`).join("  ") || "no events"}
        </Text>
      </Box>
      <Text color={COLOR.dim}>(dry-run — nothing was changed)</Text>
    </Box>
  );
};

const AuditResult = ({ data }: { data: any }) => {
  const audits: any[] = data?.audits ?? [];
  return (
    <Box flexDirection="column">
      <Text>
        worst verdict: <VerdictBadge verdict={data?.worst_verdict ?? "?"} />
      </Text>
      {audits.map((a, i) => (
        <Box key={i} flexDirection="column" marginTop={1}>
          <Text bold>
            {a.agent} ({a.method}) — <VerdictBadge verdict={a.scan_report?.verdict ?? "?"} />
          </Text>
          {(a.scan_report?.active_findings ?? []).slice(0, 5).map((f: any, j: number) => (
            <Text key={j} color={VERDICT_COLOR[f.severity] ?? "white"}>
              {"  "}{f.severity} {f.rule_id} {f.rel_path}:{f.line}
            </Text>
          ))}
          {(a.nemesis_verdicts ?? []).map((v: any, j: number) => (
            <Text key={`n${j}`}>
              {"  nemesis "}<VerdictBadge verdict={v.verdict} /> risk {v.risk_score} — {v.source}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
};

const MatrixView = () => {
  const { loading, data, error } = useEngine(["matrix"]);
  if (loading) return <Loading what="building reach matrix" />;
  if (error) return <ErrorLine msg={error} />;
  return (
    <Box flexDirection="column">
      <Text bold>Reach (native / sync / —)</Text>
      {(data?.reach ?? []).slice(0, 18).map((r: any) => (
        <Text key={r.plugin}>
          [{r.scope}] {r.plugin.padEnd(22)}
          <Text color={COLOR.ok}> {r.native.join(",") || "—"}</Text>
          {r.sync.length ? <Text color={COLOR.warn}> ↔{r.sync.join(",")}</Text> : null}
        </Text>
      ))}
    </Box>
  );
};

const SkillsView = () => {
  const { loading, data, error } = useEngine(["skills", "list"]);
  if (loading) return <Loading what="listing skills" />;
  if (error) return <ErrorLine msg={error} />;
  const skills: any[] = data?.skills ?? [];
  return (
    <Box flexDirection="column">
      <Text bold>Installed skills ({skills.length})</Text>
      {skills.length === 0 && <Text color={COLOR.dim}>none installed</Text>}
      {skills.map((s) => (
        <Text key={s.name}>
          {s.name.padEnd(34)} <Text color={s.state === "enabled" ? COLOR.ok : COLOR.warn}>{s.state}</Text>
        </Text>
      ))}
    </Box>
  );
};

const VaultView = () => {
  const { loading, data, error } = useEngine(["vault"]);
  if (loading) return <Loading what="reading vault" />;
  if (error) return <ErrorLine msg={error} />;
  const repos: any[] = data?.repos ?? [];
  return (
    <Box flexDirection="column">
      <Text bold>Repo Vault ({data?.summary?.stored ?? 0}/{data?.summary?.total ?? 0} stored)</Text>
      <Text color={COLOR.dim}>root: {data?.root ?? "not initialized"}</Text>
      {repos.slice(0, 16).map((r) => (
        <Text key={r.id ?? r.name}>
          {String(r.name ?? r.id).padEnd(24)} <Text color={r.state === "stored" ? COLOR.ok : COLOR.dim}>{r.state}</Text>
        </Text>
      ))}
    </Box>
  );
};

// ---- root -------------------------------------------------------------- //
export default function App() {
  const { exit } = useApp();
  const [view, setView] = useState<ViewId>("menu");

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.escape) setView("menu");
  });

  const inMenu = view === "menu";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text bold color={COLOR.brand}>prometheus</Text>
        <Text color={COLOR.dim}> · AI-agent plugin bridge</Text>
      </Text>
      <Box marginTop={1} flexDirection="row">
        <Box flexDirection="column" width={22} marginRight={2}>
          <Text bold underline>menu</Text>
          <SelectInput
            items={MENU}
            isFocused={inMenu}
            onSelect={(i: any) => setView(i.value)}
          />
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {view === "menu" && <Text color={COLOR.dim}>↑/↓ select · enter open · esc back · q quit</Text>}
          {view === "scan" && <ScanView />}
          {view === "catalog" && <CatalogView active={!inMenu} />}
          {view === "install" && <ActionView active={!inMenu} kind="install" />}
          {view === "audit" && <ActionView active={!inMenu} kind="audit" />}
          {view === "matrix" && <MatrixView />}
          {view === "skills" && <SkillsView />}
          {view === "vault" && <VaultView />}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={COLOR.dim}>esc menu · q quit{view !== "menu" ? " · viewing: " + view : ""}</Text>
      </Box>
    </Box>
  );
}
