// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * repl/App.tsx — the claude-style Ink REPL view (file 11 §3), GROWN from the TUI.
 *
 * EXCLUDED from the tsc build (ink/react are packaging-time deps). The view is dumb:
 * it renders @prometheus/core/repl state (transcript + footer) and dispatches
 * ReplEvents into the SHARED pure reducer. Slash commands parse + tune via the same
 * core brain the GUI uses. The agent turn (runAgentTurn) wires to an LLM client + the
 * engine bridge — injected by the host; until configured, a message echoes a hint.
 *
 *   ┌─ prometheus ──────────────────────────────────────────────────────────────┐
 *   │  ▸ you   <message>                                                          │
 *   │  ● prometheus  <agent reply / tool verdict>                                       │
 *   ├────────────────────────────────────────────────────────────────────────────┤
 *   │ › _                                                            ⏎ send · / cmd │
 *   └─ model … · tools:on · gate:enforce · dry-run:off · verbosity:normal ─────────┘
 */
import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";

import { agent, cliProfiles, repl } from "@prometheus/core";

import { loadEffectiveStartupProfile, resolveActiveProfileName } from "../profile-store.js";

import type { ParsedArgs } from "../parse.js";

export interface AppProps {
  parsed: ParsedArgs;
}

export function App({ parsed }: AppProps): JSX.Element {
  const { exit } = useApp();

  // Resolve the starting tuning: builtin ⊕ user(--profile flag > persisted active, CLI-044)
  // ⊕ project `.prom.toml` (project wins, CLI-046); a user TOML shadows a same-named builtin.
  const profileName = resolveActiveProfileName(parsed.profile);
  const startTuning = cliProfiles.resolveTuning(loadEffectiveStartupProfile(parsed));

  const [state, setState] = useState(() =>
    repl.initialReplState(startTuning, parsed.cwd ?? process.cwd()),
  );
  const [input, setInput] = useState("");

  function submit(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let next = repl.reduce(state, { type: "history", input: trimmed });
    const parsedInput = repl.parseSlash(trimmed);

    if (parsedInput.kind === "slash") {
      const { name, rest } = parsedInput;
      if (name === "quit") {
        exit();
        return;
      }
      if (name === "clear") {
        setState(repl.reduce(next, { type: "clear" }));
        setInput("");
        return;
      }
      // a live tuning verb (/model /gate /dry-run /verbosity /tools /yes /system)
      const patch = repl.tuneFromSlash(name, rest, next.tuning);
      if (patch) {
        next = repl.reduce(next, { type: "tune", patch });
        next = repl.reduce(next, {
          type: "message",
          role: "system",
          text: `tuned: ${repl.footerLine(next.tuning)}`,
        });
      } else if (repl.knownSlash(name)) {
        // pane / action slashes open a pane (panes render in M5).
        next = repl.reduce(next, { type: "message", role: "system", text: `/${name} ${rest}`.trim() });
      } else {
        next = repl.reduce(next, { type: "message", role: "system", text: `unknown command: /${name}` });
      }
      setState(next);
      setInput("");
      return;
    }

    // a plain message → the agent turn (the loop is wired by the host with an LLM
    // client + the engine bridge; defaultTuning shown here for the footer).
    next = repl.reduce(next, { type: "message", role: "you", text: trimmed });
    next = repl.reduce(next, {
      type: "message",
      role: "prometheus",
      text: agent.exposedTools(next.tuning.tools).length
        ? "(agent backend not configured in this build — wire an LLM client to runAgentTurn)"
        : "(tools are off — use /tools on)",
    });
    setState(next);
    setInput("");
  }

  useInput((ch, key) => {
    if (key.return) {
      submit(input);
    } else if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
    } else if (key.ctrl && ch === "l") {
      setState((s) => repl.reduce(s, { type: "clear" }));
    } else if (key.ctrl && (ch === "c" || ch === "d")) {
      exit();
    } else if (!key.ctrl && !key.meta && ch) {
      setInput((s) => s + ch);
    }
  });

  const rolePrefix: Record<string, string> = { you: "▸ you", prometheus: "● prometheus", system: "·" };

  return (
    <Box flexDirection="column">
      <Text>┌─ prometheus ── profile: {profileName} ──</Text>
      {state.transcript.map((m, i) => (
        <Text key={`${m.role}-${i}`}>
          {"  "}
          {rolePrefix[m.role] ?? m.role} {m.text}
        </Text>
      ))}
      <Text>───</Text>
      <Text>
        › {input}
        <Text dimColor>▏</Text>
      </Text>
      <Text dimColor>{repl.footerLine(state.tuning)}  ·  ⏎ send · / cmd · ⌃C quit</Text>
    </Box>
  );
}

export default App;
