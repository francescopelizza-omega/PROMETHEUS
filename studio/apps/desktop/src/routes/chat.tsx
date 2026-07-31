/**
 * routes/chat.tsx — the Chat activity (SPECTACULAR power-up).
 *
 * Two modes, mirroring the engine's rule (enforced server-side too):
 *  - AGENTIC (local, free): prompt a local model via window.prometheus.spectacular
 *    .chatLocal (ollama/lmstudio). Runs in-app.
 *  - TERMINAL (paid CLI): pick a CLI + settings, get the engine's injection-safe
 *    PREVIEW (window.prometheus.spectacular.chatPreview), then click OPEN — the pane
 *    TRANSFORMS into a live terminal: we spawn a pty (window.prometheus.ide), run the
 *    assembled command, stream pty.data, and forward keystrokes (pty.write). bypass
 *    requires an explicit confirm.
 *
 * Renderer-only: reaches the engine solely via window.prometheus.* (C5) and styles
 * with design tokens (no raw hex). No node/electron/engine-bridge imports.
 */
import { Button, Checkbox, Input, Panel, Select, Spinner, Textarea } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { appendScrollback } from "../renderer/ide/terminal-view.js";

type Mode = "agentic" | "terminal";
type CliId = "claude" | "codex" | "gemini" | "cursor" | "opencode";

/** Per-CLI model choices for the Terminal-chat model dropdown. The first entry is
 *  always "(CLI default)" (empty value → the CLI picks). Values are the exact strings
 *  each CLI's `--model` flag accepts; Claude Code takes stable aliases (opus/sonnet/
 *  haiku) that auto-resolve to the latest of each tier. A "✎ custom" toggle covers
 *  anything not listed (models change over time). */
const CLI_MODELS: Record<CliId, readonly { value: string; label: string }[]> = {
  claude: [
    { value: "", label: "Default (config)" },
    { value: "opus", label: "Opus (claude-opus-4-8)" },
    { value: "sonnet", label: "Sonnet (claude-sonnet-4-6)" },
    { value: "haiku", label: "Haiku (claude-haiku-4-5)" },
  ],
  codex: [
    { value: "", label: "Default (config)" },
    { value: "gpt-5-codex", label: "gpt-5-codex" },
    { value: "gpt-5", label: "gpt-5" },
    { value: "o4-mini", label: "o4-mini" },
  ],
  gemini: [
    { value: "", label: "Default (config)" },
    { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
    { value: "gemini-2.0-flash", label: "gemini-2.0-flash" },
  ],
  cursor: [
    { value: "", label: "Default (auto)" },
    { value: "auto", label: "auto" },
    { value: "gpt-5", label: "gpt-5" },
    { value: "sonnet-4.5", label: "sonnet-4.5" },
  ],
  opencode: [{ value: "", label: "Default (config)" }],
};

const COL = { display: "flex", flexDirection: "column", gap: 12 } as const;
const ROW = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } as const;
const LABEL = {
  fontSize: "var(--text-small-size, 0.8125rem)",
  color: "var(--text-secondary)",
} as const;
const CODE = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-code-size, 0.875rem)",
  background: "var(--bg-inset)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md, 6px)",
  padding: 12,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
} as const;

/** POSIX single-quote a token so the assembled shell line is injection-safe. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
/** Build a safe shell command line from the engine's argv + env overrides. */
function toShellLine(argv: string[], env: Record<string, string>): string {
  const e = Object.entries(env).map(([k, v]) => `${k}=${shQuote(v)}`);
  return [...e, ...argv.map(shQuote)].join(" ");
}

interface BuiltCommand {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  label: string;
  display: string;
}

function AgenticChat(): ReactElement {
  const [model, setModel] = useState("qwen3:8b");
  const [runner, setRunner] = useState("ollama");
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [root, setRoot] = useState<string>("");
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  // the ollama-pullable model catalog + which tags are already installed locally.
  const [catalog, setCatalog] = useState<{ tag: string; name: string; params?: string }[]>([]);
  const [installedTags, setInstalledTags] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState(false);

  // Seed the prompt typed on the Home AI bar (handed over via sessionStorage), once.
  useEffect(() => {
    try {
      const seed = sessionStorage.getItem("prometheus.home.prompt");
      if (seed) {
        setPrompt(seed);
        sessionStorage.removeItem("prometheus.home.prompt");
      }
    } catch {
      /* sessionStorage blocked — nothing to seed */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    window.prometheus.spectacular
      .modelsConfig()
      .then((r) => {
        if (alive && r.ok && r.modelsRoot) setRoot(r.modelsRoot);
      })
      .catch(() => {
        /* config read failed — leave root blank, never crash the route */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Load the ollama-pullable model catalog (→ the dropdown) + the installed set.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await window.prometheus.models.search({
          source: "ollama",
          freeOnly: false,
          limit: 300,
        });
        if (alive && r.ok && Array.isArray(r.models)) {
          const seen = new Set<string>();
          const list: { tag: string; name: string; params?: string }[] = [];
          for (const raw of r.models as Record<string, unknown>[]) {
            const tag = typeof raw.ollama === "string" ? raw.ollama : "";
            if (!tag || seen.has(tag)) continue;
            seen.add(tag);
            list.push({
              tag,
              name: typeof raw.name === "string" ? raw.name : tag,
              ...(typeof raw.params === "string" ? { params: raw.params } : {}),
            });
          }
          if (list.length > 0) setCatalog(list);
        }
      } catch {
        /* catalog unavailable — the custom-tag field still works */
      }
      try {
        const lib = await window.prometheus.models.library();
        if (alive && lib.ok && Array.isArray(lib.models)) {
          setInstalledTags(
            new Set((lib.models as Record<string, unknown>[]).map((m) => String(m.id ?? ""))),
          );
        }
      } catch {
        /* library read failed — badges just won't show */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Live download % during an install (the pull streams model:progress events).
  useEffect(() => {
    const feed = window.prometheus.models.onProgress;
    if (typeof feed !== "function") return;
    return feed((e) => {
      if (typeof e.pct === "number") setPct(e.pct);
    });
  }, []);

  const send = useCallback(async () => {
    if (!model.trim() || !prompt.trim()) return;
    setBusy(true);
    setErr(null);
    setReply(null);
    try {
      const r = await window.prometheus.spectacular.chatLocal(model.trim(), prompt.trim(), runner);
      if (r.ok && typeof r.response === "string") setReply(r.response);
      else setErr(r.error ?? "the local model server is unreachable");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "chat failed");
    } finally {
      setBusy(false); // never leave the Send button stuck spinning
    }
  }, [model, prompt, runner]);

  // PROPOSE + perform a real local-model install (the actual weight fetch, file 05 §5):
  // ollama pulls + serves the model the user typed, so the agentic-local chat can run.
  const installModel = useCallback(async () => {
    const id = model.trim();
    if (!id || installing) return;
    // guard a stale running instance: the preload only reloads on a FULL app restart,
    // so an app launched before this build won't have models.pull yet.
    if (typeof window.prometheus.models.pull !== "function") {
      setInstallMsg(
        "Fully quit + relaunch Prometheus to load the model installer (pkill electron; pnpm dev).",
      );
      return;
    }
    setInstalling(true);
    setPct(0);
    setInstallMsg(`ollama pull ${id} — downloading…`);
    try {
      let r = await window.prometheus.models.pull({ id });
      // Ollama missing? Install the runner ON THE USER'S BEHALF (OS-aware, in main),
      // then transparently retry the pull — no copy-paste command handed to the user.
      if (r.installable && typeof window.prometheus.models.installRunner === "function") {
        setInstallMsg("Ollama isn't installed — installing it for your OS…");
        const ir = await window.prometheus.models.installRunner();
        if (ir.ok && ir.installed) {
          setInstallMsg(`✓ Ollama installed (${ir.os ?? "local"}). Downloading ${id}…`);
          r = await window.prometheus.models.pull({ id });
        } else if (ir.blockedByResources) {
          setInstallMsg(`⛔ ${ir.error ?? "system under heavy load"}`);
          return;
        } else if (ir.manual) {
          setInstallMsg(`⚠ ${ir.install ?? ir.url ?? "manual install needed"}`);
          return;
        } else {
          setInstallMsg(`✗ Ollama install failed — ${ir.error ?? "unknown error"}`);
          return;
        }
      }
      if (r.ok && r.installed) {
        setInstallMsg(
          `✓ installed ${id} — served at ${r.endpoint ?? "localhost:11434"}. Press Send.`,
        );
        setInstalledTags((s) => new Set(s).add(id));
        setErr(null);
      } else if (r.installable) {
        setInstallMsg(
          `⚠ Ollama runner not installed — ${r.install ?? "https://ollama.com/download"}`,
        );
      } else if (r.blockedByResources) {
        setInstallMsg(`⛔ ${r.error ?? "system under heavy load"}`);
      } else {
        setInstallMsg(`✗ ${r.error ?? "install failed"}`);
      }
    } catch (e) {
      setInstallMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
      setPct(null);
    }
  }, [model, installing]);

  const pickFolder = useCallback(async () => {
    try {
      const picked = await window.prometheus.folderOpen({
        title: "Choose the models install folder",
      });
      if (picked.ok && picked.path) {
        const saved = await window.prometheus.spectacular.modelsConfig(picked.path);
        if (saved.ok && saved.modelsRoot) setRoot(saved.modelsRoot);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not set the models folder");
    }
  }, []);

  return (
    <div style={COL}>
      <Panel title="Models folder" elevation="e1">
        <div style={ROW}>
          <span style={LABEL}>install folder:</span>
          <code style={{ ...CODE, padding: "4px 8px" }}>
            {root || "(default ~/.prometheus/models)"}
          </code>
          <Button variant="secondary" size="sm" onClick={() => void pickFolder()}>
            Change folder…
          </Button>
        </div>
      </Panel>

      <Panel title="Agentic chat — local model (free, on-device)" elevation="e1">
        <div style={COL}>
          <div style={ROW}>
            <span style={LABEL}>model</span>
            {custom || catalog.length === 0 ? (
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="ollama tag, e.g. qwen3:8b"
                mono
              />
            ) : (
              <Select
                aria-label="model"
                options={catalog.map((m) => ({
                  value: m.tag,
                  label: `${m.name}${m.params ? ` · ${m.params}` : ""}${installedTags.has(m.tag) ? "  ✓ installed" : ""}`,
                }))}
                value={model}
                onValueChange={setModel}
              />
            )}
            <Button variant="ghost" size="sm" onClick={() => setCustom((c) => !c)}>
              {custom ? "▾ catalog" : "✎ custom"}
            </Button>
            <span style={LABEL}>runner</span>
            <Select
              aria-label="local runner"
              options={[
                { value: "ollama", label: "Ollama (:11434)" },
                { value: "lmstudio", label: "LM Studio (:1234)" },
              ]}
              value={runner}
              onValueChange={setRunner}
            />
          </div>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Type your prompt…"
            rows={4}
          />
          <div style={ROW}>
            <Button variant="primary" size="md" onClick={() => void send()} disabled={busy}>
              {busy ? "Thinking…" : "Send"}
            </Button>
            {busy ? <Spinner size={16} /> : null}
            {runner === "ollama" ? (
              <Button
                variant={installedTags.has(model.trim()) ? "ghost" : "secondary"}
                size="sm"
                onClick={() => void installModel()}
                disabled={installing}
                title={`ollama pull ${model} — download + serve this model on-device`}
              >
                {installing
                  ? `Installing…${pct != null ? ` ${pct}%` : ""}`
                  : installedTags.has(model.trim())
                    ? `↻ Re-install ${model}`
                    : `⚡ Install ${model}`}
              </Button>
            ) : null}
          </div>
          {err ? (
            <div style={{ ...CODE, color: "var(--danger)" }}>
              {err}
              {"\n\n"}No local model is running.
              {runner === "ollama"
                ? " Click ⚡ Install to download + serve it on-device (via Ollama)."
                : " Open LM Studio and Start Server, or switch the runner to Ollama and install."}
            </div>
          ) : null}
          {installMsg ? <div style={CODE}>{installMsg}</div> : null}
          {reply ? <div style={CODE}>{reply}</div> : null}
        </div>
      </Panel>
    </div>
  );
}

/** The live terminal that the OPEN button transforms the pane into. */
function LiveTerminal({ cmd, onClose }: { cmd: BuiltCommand; onClose: () => void }): ReactElement {
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [scroll, setScroll] = useState("");
  const [line, setLine] = useState("");
  const [exited, setExited] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Spawn once, ATTACH the stream listener, THEN write the command. Doing all three
  // in one effect (keyed off the resolved pty id, not React state) closes the race
  // where output emitted between ptyWrite and a later listener-attach would be lost.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    const bridge = window.prometheus?.ide;
    if (!bridge) {
      setErr("the IDE pty host is unavailable");
      return;
    }
    void bridge.ptySpawn({ cwd: cmd.cwd, cols: 100, rows: 28 }).then((res) => {
      if (!alive) {
        // unmounted before spawn resolved — don't leak the pty
        if (res.ok && res.ptyId) bridge.ptyKill?.(res.ptyId);
        return;
      }
      if (!res.ok || !res.ptyId) {
        setErr(`failed to open terminal: ${res.error ?? "unknown error"}`);
        return;
      }
      const id = res.ptyId;
      setPtyId(id);
      if (bridge.onEvent) {
        off = bridge.onEvent((ev) => {
          if (ev.channel === "pty.data" && ev.ptyId === id) {
            setScroll((s) => appendScrollback(s, ev.data));
          } else if (ev.channel === "pty.exit" && ev.ptyId === id) {
            setExited(true);
          }
        });
      }
      // write LAST — the listener is already live, so the command's output is captured.
      bridge.ptyWrite(id, `${toShellLine(cmd.argv, cmd.env)}\r`);
    });
    return () => {
      alive = false;
      if (off) off();
    };
  }, [cmd]);

  const sendLine = (): void => {
    const bridge = window.prometheus?.ide;
    if (!bridge || !ptyId) return;
    bridge.ptyWrite(ptyId, `${line}\r`);
    setLine("");
  };

  const close = (): void => {
    if (ptyId) window.prometheus?.ide?.ptyKill(ptyId);
    onClose();
  };

  return (
    <div style={COL}>
      <div style={ROW}>
        <span style={LABEL}>
          ▶ {cmd.label} — live terminal {exited ? "(exited)" : "(running)"}
        </span>
        <Button variant="ghost" size="sm" onClick={close}>
          ✕ close
        </Button>
      </div>
      {err ? <div style={{ ...CODE, color: "var(--danger)" }}>{err}</div> : null}
      <pre
        aria-label="terminal output"
        role="log"
        aria-live="polite"
        style={{ ...CODE, height: "min(320px, 45vh)", overflow: "auto" }}
      >
        {scroll || "starting…"}
      </pre>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendLine();
        }}
        style={ROW}
      >
        <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>›</span>
        <Input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          disabled={!ptyId || exited}
          placeholder="type to the terminal…"
          mono
        />
      </form>
    </div>
  );
}

function TerminalChat(): ReactElement {
  const [cli, setCli] = useState<CliId>("claude");
  const [model, setModel] = useState("");
  // when set, type a model the dropdown doesn't list (per-CLI models drift over time).
  const [customModel, setCustomModel] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [bypass, setBypass] = useState(false);
  const [tmux, setTmux] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [cmd, setCmd] = useState<BuiltCommand | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  const build = useCallback(async () => {
    setErr(null);
    setCopied(false);
    setCmd(null);
    const r = await window.prometheus.spectacular.chatPreview(cli, {
      model: model.trim() || undefined,
      systemPrompt: systemPrompt.trim() || undefined,
      bypass,
      tmux: tmux ? true : undefined,
      prompt: prompt.trim() || undefined,
    });
    if (!r.ok || !r.argv) {
      setErr(r.error ?? "could not build the command");
      setNotes([]);
      return;
    }
    const env = r.env ?? {};
    const display = [...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...r.argv].join(" ");
    setCmd({ argv: r.argv, env, cwd: r.cwd ?? "~", label: r.label ?? cli, display });
    setNotes(r.notes ?? []);
  }, [cli, model, systemPrompt, bypass, tmux, prompt]);

  const copy = useCallback(() => {
    if (cmd && navigator.clipboard) {
      void navigator.clipboard.writeText(cmd.display).then(() => setCopied(true));
    }
  }, [cmd]);

  const doOpen = useCallback(() => {
    if (!cmd) return;
    if (
      bypass &&
      !window.confirm(
        "Bypass permissions: the agent will act WITHOUT confirmations. Open the terminal anyway?",
      )
    ) {
      return;
    }
    setOpen(true);
  }, [cmd, bypass]);

  const cliOptions = [
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "OpenAI Codex" },
    { value: "gemini", label: "Gemini CLI" },
    { value: "cursor", label: "Cursor Agent" },
    { value: "opencode", label: "OpenCode" },
  ];

  if (open && cmd) {
    return (
      <Panel title={`Terminal chat — ${cmd.label}`} elevation="e1">
        <LiveTerminal cmd={cmd} onClose={() => setOpen(false)} />
      </Panel>
    );
  }

  return (
    <Panel title="Terminal chat — paid CLI (settings → preview → OPEN)" elevation="e1">
      <div style={COL}>
        <div style={ROW}>
          <span style={LABEL}>service</span>
          <Select
            aria-label="terminal CLI service"
            options={cliOptions}
            value={cli}
            onValueChange={(v) => {
              setCli(v as CliId);
              // the selected model may not exist for the new CLI — reset to its default.
              setModel("");
              setCustomModel(false);
            }}
          />
          <span style={LABEL}>model</span>
          {customModel ? (
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model name (CLI-specific)"
              mono
            />
          ) : (
            <Select
              aria-label="terminal model"
              options={CLI_MODELS[cli] as { value: string; label: string }[]}
              value={model}
              onValueChange={setModel}
            />
          )}
          <Button variant="ghost" size="sm" onClick={() => setCustomModel((c) => !c)}>
            {customModel ? "▾ list" : "✎ custom"}
          </Button>
        </div>
        <div style={ROW}>
          <span style={LABEL}>system-prompt file</span>
          <Input
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="/path/to/system.md (optional)"
            mono
          />
        </div>
        <div style={ROW}>
          <Checkbox
            checked={bypass}
            onCheckedChange={setBypass}
            label="bypass permissions (dangerous)"
          />
          <Checkbox checked={tmux} onCheckedChange={setTmux} label="wrap in tmux (leave-PC)" />
        </div>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="optional one-shot prompt (else interactive)"
          rows={3}
        />
        <div style={ROW}>
          <Button variant="primary" size="md" onClick={() => void build()}>
            Preview command
          </Button>
          {cmd ? (
            <>
              <Button variant="primary" size="md" onClick={doOpen}>
                Open in terminal ▶
              </Button>
              <Button variant="secondary" size="sm" onClick={copy}>
                {copied ? "Copied ✓" : "Copy command"}
              </Button>
            </>
          ) : null}
        </div>
        {err ? <div style={{ ...CODE, color: "var(--danger)" }}>{err}</div> : null}
        {bypass ? (
          <div style={{ ...LABEL, color: "var(--warn)" }}>
            ⚠ bypass lets the agent act without confirmations — only for trusted, supervised runs.
          </div>
        ) : null}
        {cmd ? (
          <>
            <div style={LABEL}>command (OPEN runs this in a live terminal):</div>
            <div style={CODE}>{cmd.display}</div>
            <div style={LABEL}>cwd: {cmd.cwd}</div>
            {notes.map((n) => (
              <div key={n} style={{ ...LABEL, color: "var(--warn)" }}>
                {n}
              </div>
            ))}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

export function ChatRoute(): ReactElement {
  const [mode, setMode] = useState<Mode>("agentic");
  return (
    <div style={{ padding: 16, height: "100%", overflow: "auto", ...COL }}>
      <div style={ROW}>
        <Button
          variant={mode === "agentic" ? "primary" : "ghost"}
          size="sm"
          onClick={() => setMode("agentic")}
        >
          Agentic (local)
        </Button>
        <Button
          variant={mode === "terminal" ? "primary" : "ghost"}
          size="sm"
          onClick={() => setMode("terminal")}
        >
          Terminal (paid CLI)
        </Button>
      </div>
      {mode === "agentic" ? <AgenticChat /> : <TerminalChat />}
    </div>
  );
}

export default ChatRoute;
