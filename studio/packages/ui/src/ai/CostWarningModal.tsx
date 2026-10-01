// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * CostWarningModal.tsx — the loud PAY-PER-USE typed-confirm modal (file 12 §4.1).
 *
 * The cost analogue of the security force-override ([[03]] §5.2). Shown BEFORE any
 * Tier-C connector is enabled (and re-shown if its model/endpoint changes). Blocking
 * + unmissable: no scrim dismissal, the confirm button stays DISABLED until the user
 * types the EXACT phrase `ENABLE METERED` AND sets a positive monthly cap. The free
 * "use a local model instead" path is an equal-weight CTA, never buried (§4.1/§6).
 *
 * Presentational only — it raises intent (onConfirm / onUseLocalInstead / onCancel);
 * the container writes ConnectorConfig.confirmedCostWarningAt + the audit record (C5).
 */
import { type CSSProperties, type ReactElement, useId, useState } from "react";
import { Button } from "../components/Button.js";
import { Dialog } from "../components/primitives/Dialog.js";
import { Input } from "../components/primitives/Input.js";
import { Switch } from "../components/primitives/Toggle.js";
import { fs, rad, sp, v } from "../components/primitives/styles.js";
import { type CostWarningInput, confirmEnabled, costWarningCopy } from "./types.js";

export interface CostWarningConfirm {
  monthlyCapUsd: number;
  autoDisableAtCap: boolean;
}

export interface CostWarningModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: CostWarningInput;
  /** initial monthly cap shown in the field (default 20.00, per the §4.1 mock). */
  defaultCapUsd?: number;
  /** confirm — fires ONLY when the phrase matches + a positive cap is set. */
  onConfirm: (confirm: CostWarningConfirm) => void;
  /** route into the §6 "run it locally for $0" flow (the equal-weight free path). */
  onUseLocalInstead?: () => void;
}

/** The §4.1 metered-service warn + typed-confirm modal. */
export function CostWarningModal({
  open,
  onOpenChange,
  provider,
  defaultCapUsd = 20,
  onConfirm,
  onUseLocalInstead,
}: CostWarningModalProps): ReactElement {
  const copy = costWarningCopy(provider);
  const [typed, setTyped] = useState("");
  const [capText, setCapText] = useState(defaultCapUsd.toFixed(2));
  const [autoDisable, setAutoDisable] = useState(true);
  const capUsd = Number.parseFloat(capText);
  const cap = Number.isFinite(capUsd) ? capUsd : 0;
  const canConfirm = confirmEnabled(typed, cap);
  const capId = useId();
  const confirmId = useId();

  const dt: CSSProperties = {
    color: v("text-secondary"),
    fontFamily: v("font-mono"),
    fontSize: fs("small"),
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissOnScrim={false}
      hideClose
      width={640}
      title={
        <span
          style={{ color: v("danger"), display: "inline-flex", alignItems: "center", gap: sp(2) }}
        >
          {copy.title}
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {copy.cancelLabel}
          </Button>
          <Button
            variant="danger"
            disabled={!canConfirm}
            onClick={() => onConfirm({ monthlyCapUsd: cap, autoDisableAtCap: autoDisable })}
          >
            {copy.confirmLabel}
          </Button>
        </>
      }
    >
      {copy.body.map((para) => (
        <p
          key={para.slice(0, 24)}
          style={{ margin: `0 0 ${sp(3)}`, fontSize: fs("body"), lineHeight: 1.5 }}
        >
          {para}
        </p>
      ))}

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          gap: `${sp(1)} ${sp(4)}`,
          margin: `${sp(4)} 0`,
          padding: sp(4),
          background: v("bg-inset"),
          border: `1px solid ${v("border-subtle")}`,
          borderRadius: rad("md"),
        }}
      >
        <dt style={dt}>Provider</dt>
        <dd style={{ ...dt, margin: 0, color: v("text-primary") }}>{provider.providerLabel}</dd>
        {provider.modelLabel != null && (
          <>
            <dt style={dt}>Model</dt>
            <dd style={{ ...dt, margin: 0, color: v("text-primary") }}>
              {provider.modelLabel}
              {provider.priceLine ? `   ${provider.priceLine}` : ""}
            </dd>
          </>
        )}
        <dt style={dt}>Billing</dt>
        <dd style={{ ...dt, margin: 0, color: v("warn") }}>
          METERED — not covered by any subscription.
        </dd>
      </dl>

      {copy.localAltCta != null && onUseLocalInstead != null && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: sp(3),
            margin: `${sp(4)} 0`,
            padding: sp(4),
            background: v("bg-inset"),
            border: `1px solid ${v("ok")}`,
            borderRadius: rad("md"),
          }}
        >
          <span aria-hidden="true" style={{ color: v("ok") }}>
            ▸
          </span>
          <span style={{ flex: 1, fontSize: fs("small") }}>
            A FREE alternative: run an open-weight model LOCALLY for $0.
          </span>
          <Button variant="secondary" onClick={onUseLocalInstead}>
            {copy.localAltCta}
          </Button>
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: sp(4),
          marginBottom: sp(3),
        }}
      >
        <label
          htmlFor={capId}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: sp(2),
            fontSize: fs("small"),
          }}
        >
          Monthly cap (USD):
          <Input
            id={capId}
            inputMode="decimal"
            value={capText}
            onChange={(e) => setCapText(e.currentTarget.value)}
            aria-invalid={cap <= 0}
            style={{ width: "7rem" }}
          />
        </label>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: sp(2),
            fontSize: fs("small"),
          }}
        >
          <Switch
            checked={autoDisable}
            onCheckedChange={setAutoDisable}
            aria-label="Auto-disable at cap"
          />
          Auto-disable at cap
        </span>
      </div>

      <label
        htmlFor={confirmId}
        style={{ display: "block", fontSize: fs("small"), marginBottom: sp(2) }}
      >
        To proceed anyway, set a monthly budget cap and type{" "}
        <code style={{ color: v("danger"), fontFamily: v("font-mono") }}>ENABLE METERED</code>
      </label>
      <Input
        id={confirmId}
        value={typed}
        onChange={(e) => setTyped(e.currentTarget.value)}
        placeholder="Type to confirm"
        aria-label="Type ENABLE METERED to confirm"
        autoComplete="off"
        spellCheck={false}
      />
      {!canConfirm && (
        <p style={{ margin: `${sp(2)} 0 0`, color: v("text-secondary"), fontSize: fs("small") }}>
          {cap <= 0
            ? "Set a positive monthly cap, then type the exact phrase to enable."
            : "Type the exact phrase ENABLE METERED to enable."}
        </p>
      )}
    </Dialog>
  );
}

export default CostWarningModal;
