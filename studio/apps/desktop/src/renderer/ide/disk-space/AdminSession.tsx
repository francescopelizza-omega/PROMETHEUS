// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * AdminSession — the Disk space panel's side of "Open as administrator".
 *
 * Nothing here can elevate, and nothing here shows or types into the root program. It asks main
 * to open the session: the approval dialog shows the exact root command, sudo's native password
 * dialog asks (every time), and only then does disk_space.py run as root — in its OWN window,
 * whose keys come from the keyboard, never from this page. The panel reports how it ended and can
 * Stop it.
 */
import { Button, Spinner } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useEffect, useState } from "react";
import { type AdminEndMessage, adminEndMessage } from "./admin-view.js";

const small: CSSProperties = { fontSize: "var(--text-small-size, 0.8125rem)" };

export function AdminSession({ onClose }: { onClose(): void }): ReactElement {
  const [end, setEnd] = useState<AdminEndMessage | null>(null);

  useEffect(() => {
    let disposed = false;
    const api = window.prometheus?.diskSpace;
    if (!api) {
      setEnd({ tone: "error", text: "Not available in this build." });
      return;
    }
    void api.openAsAdmin({}).then((r) => {
      if (!disposed) setEnd(adminEndMessage(r));
    });
    return () => {
      disposed = true;
      api.adminStop();
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-4, 8px)",
        margin: "var(--space-4, 8px) 0",
      }}
    >
      <strong style={small}>disk-space as administrator</strong>
      <span style={{ ...small, color: "var(--text-secondary)", flex: "1 1 auto", minWidth: 0 }}>
        {end ? (
          <span
            role={end.tone === "error" ? "alert" : "status"}
            style={{ color: end.tone === "error" ? "var(--danger)" : "var(--text-secondary)" }}
          >
            {end.text}
          </span>
        ) : (
          <>
            <Spinner size={14} /> Approve the command, then enter your password in the system
            dialog. It opens in its own window, where only your keyboard can type.
          </>
        )}
      </span>
      {end ? (
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => window.prometheus.diskSpace.adminStop()}>
          Stop
        </Button>
      )}
    </div>
  );
}
