// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/shell/PrivilegedApprovalDialog.tsx — the human's answer to a privileged command.
 *
 * Mounted ONCE, at the app root. Main's privileged gate sends one request per exact command
 * (`privileged:request`); this shows it verbatim — the command, its folder, who asked and why,
 * a script's hash and first lines — and answers that one request id with Approve once or Deny.
 *
 *  - **Deny is the default.** It holds focus when the dialog opens, Escape and the backdrop deny,
 *    and so does the countdown running out (main also closes the request).
 *  - **No "always".** Two buttons, one request, one answer.
 *  - **A catastrophic command** (`rm -rf /`, `dd of=/dev/…`, `mkfs`, sudoers) keeps Approve
 *    disabled until its target is typed exactly.
 *  - **No password here.** sudo's askpass helper asks for it in a native dialog and hands it
 *    straight to sudo; this renderer never sees it.
 *
 * Renderer-only: `window.prometheus.privileged` + tokens. No core or engine-bridge import.
 */
import { Button, Z, useFocusTrap } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import type { PrivilegedPromptView } from "../../shared/ipc-contract.js";
import {
  type QueueEvent,
  canApprove,
  countdownLabel,
  reduceQueue,
} from "./privileged-dialog-view.js";

export function PrivilegedApprovalDialog(): ReactElement | null {
  const [queue, setQueue] = useState<PrivilegedPromptView[]>([]);
  const [typed, setTyped] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /** when each request arrived — main's clock started then, not when it reached the head */
  const receivedAt = useRef(new Map<string, number>());
  const dispatch = useCallback((ev: QueueEvent) => {
    if (ev.type === "request") receivedAt.current.set(ev.view.id, Date.now());
    else receivedAt.current.delete(ev.id);
    setQueue((q) => reduceQueue(q, ev));
  }, []);

  useEffect(() => {
    const api = window.prometheus?.privileged;
    if (!api) return;
    const offRequest = api.onRequest((view) => dispatch({ type: "request", view }));
    const offClose = api.onClose((msg) => dispatch({ type: "close", id: msg.id }));
    return () => {
      offRequest();
      offClose();
    };
  }, [dispatch]);

  const head = queue[0];
  const headId = head?.id;

  const answer = useCallback(
    (decision: "approve" | "deny") => {
      if (!head) return;
      const id = head.id;
      dispatch({ type: "answered", id });
      void window.prometheus.privileged.decide(
        decision === "approve"
          ? { id, decision, ...(head.phrase ? { phrase: typed.trim() } : {}) }
          : { id, decision: "deny" },
      );
    },
    [head, typed, dispatch],
  );
  const deny = useCallback(() => answer("deny"), [answer]);

  const dialogRef = useRef<HTMLElement | null>(null);
  const denyRef = useRef<HTMLButtonElement | null>(null);
  useFocusTrap(dialogRef, Boolean(head), deny, {
    skipInitialFocus: true,
    deferTabToTextFields: true,
  });

  // A new request: clear the typed phrase, focus Deny, start the clock.
  useEffect(() => {
    if (!headId) return;
    setTyped("");
    setNow(Date.now());
    denyRef.current?.focus();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [headId]);

  const remaining = head ? head.timeoutMs - (now - (receivedAt.current.get(head.id) ?? now)) : 0;
  useEffect(() => {
    if (head && remaining <= 0) answer("deny");
  }, [head, remaining, answer]);

  if (!head) return null;
  const [title, command, ...details] = head.lines;
  const approvable = canApprove(head, typed);

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is owned by useFocusTrap (document capture) */}
      <div
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) deny();
        }}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: Z.modal,
        }}
      >
        <section
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-label="Approve a privileged command"
          style={{
            width: 640,
            maxWidth: "92vw",
            maxHeight: "90vh",
            // the title, the command and the buttons stay put; only the details scroll. With the
            // whole dialog scrolling, focusing Deny scrolled the COMMAND out of view whenever a
            // long script preview made it tall — the human saw everything but what they approve.
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "var(--bg-surface-2)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius-xl, 14px)",
            boxShadow: "0 16px 48px rgba(0,0,0,.5)",
            padding: "var(--space-8, 16px)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-ui)",
          }}
        >
          <h2
            style={{
              margin: 0,
              flexShrink: 0,
              fontSize: "var(--text-h2-size, 1rem)",
              color: "var(--danger)",
            }}
          >
            {title}
          </h2>
          <code
            style={{
              display: "block",
              flexShrink: 0,
              // a very long command scrolls inside its own box; it never pushes the buttons off
              maxHeight: "40vh",
              overflowY: "auto",
              margin: "var(--space-6, 12px) 0",
              padding: "var(--space-4, 8px)",
              background: "var(--bg-surface)",
              borderRadius: "var(--radius-md, 6px)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.85rem",
              overflowWrap: "break-word",
            }}
          >
            {command?.trim()}
          </code>
          <pre
            style={{
              margin: 0,
              flex: "1 1 auto",
              minHeight: 0,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              overflowWrap: "break-word",
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              color: "var(--text-secondary)",
            }}
          >
            {details.join("\n")}
          </pre>
          {head.phrase ? (
            <label style={{ display: "block", flexShrink: 0, marginTop: "var(--space-6, 12px)" }}>
              <span style={{ fontSize: "0.8rem" }}>
                Type <code>{head.phrase}</code> to approve:
              </span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-label={`type ${head.phrase} to approve`}
                spellCheck={false}
                autoComplete="off"
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: "var(--space-2, 4px)",
                  fontFamily: "var(--font-mono)",
                }}
              />
            </label>
          ) : null}
          <div
            style={{
              display: "flex",
              flexShrink: 0,
              alignItems: "center",
              gap: "var(--space-4, 8px)",
              marginTop: "var(--space-8, 16px)",
            }}
          >
            <span
              style={{ flex: 1, minWidth: 0, fontSize: "0.75rem", color: "var(--text-secondary)" }}
            >
              {countdownLabel(remaining)}
              {queue.length > 1 ? ` · ${queue.length - 1} more waiting` : ""}
            </span>
            <Button ref={denyRef} size="sm" variant="primary" onClick={deny}>
              Deny
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!approvable}
              onClick={() => answer("approve")}
              title={
                approvable
                  ? "run this exact command once, as administrator"
                  : "type the target first"
              }
            >
              Approve once
            </Button>
          </div>
        </section>
      </div>
    </>
  );
}
