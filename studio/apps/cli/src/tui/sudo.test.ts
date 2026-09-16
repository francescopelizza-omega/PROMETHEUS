/**
 * sudo.test.ts — elevation detection, the exact ack prompt, and the decision matrix.
 */
import assert from "node:assert/strict";

import { test } from "node:test";
import { DEFAULT_AUTH_LEVEL, MAX_AUTH_LEVEL } from "@prometheus/core/agent-authorization";

import {
  SUDO_ACK_PROMPT,
  detectElevation,
  interpretSudoAnswer,
  isElevated,
  resolveSudoDecision,
  runElevationGate,
  sudoWarningLines,
} from "./sudo.js";

test("detectElevation: sudo wins via SUDO_USER even when uid is 0", () => {
  assert.equal(detectElevation({ env: { SUDO_USER: "fp" }, getuid: () => 0 }), "sudo");
  assert.equal(detectElevation({ env: { SUDO_UID: "501" }, getuid: () => 1000 }), "sudo");
});

test("detectElevation: root via uid 0, none otherwise", () => {
  assert.equal(detectElevation({ env: {}, getuid: () => 0 }), "root");
  assert.equal(detectElevation({ env: {}, getuid: () => 501 }), null);
  // no getuid (Windows) + no sudo env → not elevated
  assert.equal(detectElevation({ env: {} }), null);
});

test("isElevated mirrors detectElevation", () => {
  assert.equal(isElevated({ env: {}, getuid: () => 0 }), true);
  assert.equal(isElevated({ env: {}, getuid: () => 501 }), false);
});

test("the ack prompt is the mandated verbatim CAPS string", () => {
  assert.equal(
    SUDO_ACK_PROMPT,
    "YOU ARE CONSIDERED AS A HUMAN BEING THAT CAN UNDERSTAND THE HARM AND CAN THEN AUTHORISE PROMETHEUS TO START UP WITH SUCH PRIVILEDGES: [Y/n]",
  );
  // the warning body ends with that exact prompt
  assert.equal(sudoWarningLines("root").at(-1), SUDO_ACK_PROMPT);
});

test("interpretSudoAnswer: only n/N/No/NO decline; default+others authorize", () => {
  for (const no of ["n", "N", "no", "No", "NO", " no "]) {
    assert.equal(interpretSudoAnswer(no), "decline", no);
  }
  for (const yes of ["", "y", "Y", "yes", "YES", "sure", "ok"]) {
    assert.equal(interpretSudoAnswer(yes), "authorize", JSON.stringify(yes));
  }
});

test("resolveSudoDecision: not elevated → pass-through, bypass available", () => {
  const d = resolveSudoDecision(null, null);
  assert.equal(d.proceed, true);
  assert.equal(d.bypassLocked, false);
  assert.equal(d.startMode, "default");
});

test("resolveSudoDecision: decline → force default + lock bypass (still proceeds)", () => {
  const d = resolveSudoDecision("sudo", "n");
  assert.equal(d.proceed, true);
  assert.equal(d.startMode, "default");
  assert.equal(d.bypassLocked, true);
  assert.match(d.note, /asking before every change/);
});

test("resolveSudoDecision: a DECLINE caps autonomy at the level its own note promises", () => {
  // The cap used to be level 5 ("installs") written by hand in each host, under a note saying
  // the session was in ask-before-everything mode: a declined root session auto-approved reads,
  // edits, config changes, shell commands AND installs. The promise and the ceiling now come
  // from one object, so they cannot disagree again.
  const declined = resolveSudoDecision("sudo", "n");
  assert.equal(declined.maxAuthLevel, DEFAULT_AUTH_LEVEL);
  assert.ok(declined.maxAuthLevel < 5, "a declined gate must not still auto-approve installs");
  // an ACKNOWLEDGED gate imposes no ceiling at all — the operator said yes
  assert.equal(resolveSudoDecision("root", "").maxAuthLevel, MAX_AUTH_LEVEL);
  // and a session that was never elevated is not capped either
  assert.equal(resolveSudoDecision(null, null).maxAuthLevel, MAX_AUTH_LEVEL);
});

test("resolveSudoDecision: authorize → bypass reachable", () => {
  const d = resolveSudoDecision("root", "");
  assert.equal(d.bypassLocked, false);
  assert.match(d.note, /acknowledged/);
  // it must not send the user to a command that does not exist
  assert.doesNotMatch(d.note, /\/permissions\b/);
  assert.match(d.note, /\/permission-mode/);
});

test("resolveSudoDecision: a null answer when elevated is treated as decline (fail-safe)", () => {
  const d = resolveSudoDecision("root", null);
  assert.equal(d.bypassLocked, true);
});

test("the elevation gate is runnable by EVERY host, and a host with nobody to ask declines", async () => {
  /**
   * The red warning, the mandatory acknowledgement and the bypass clamp lived inside the TUI and
   * nowhere else. `sudo prometheus --plain` / `--tmux` / `-p`, and every scheduled task, opened a
   * root session with none of them — restoring the persisted authorisation level unclamped and
   * auto-approving against it — while the same `sudo prometheus` in the default TUI stopped for a
   * full-screen acknowledgement. `--plain`/`--tmux` is the surface used over SSH and inside tmux,
   * where a sudo launch is likeliest of all.
   *
   * `isElevated` was exported with no production caller anywhere, which is the shape of a gate
   * that was written and then only half-wired.
   */
  const realEnv = process.env.SUDO_USER;
  process.env.SUDO_USER = "someone";
  try {
    // a host that CAN ask: an explicit "n" declines and locks bypass
    const lines: string[] = [];
    const declined = await runElevationGate({
      write: (l) => lines.push(l),
      ask: async () => "n",
    });
    assert.equal(declined.bypassLocked, true);
    assert.ok(
      lines.some((l) => l.includes("ELEVATED PRIVILEGES")),
      "the warning must be printed on every host, not just the TUI",
    );

    // the [Y/n] default authorises, exactly as in the TUI
    const ok = await runElevationGate({ write: () => {}, ask: async () => "" });
    assert.equal(ok.bypassLocked, false);

    // NOBODY to ask (headless, a pipe, a scheduled task) → the safe branch, not a skip
    const headless = await runElevationGate({ write: () => {} });
    assert.equal(headless.bypassLocked, true, "an unattended elevated run must lock bypass");
    assert.equal(headless.startMode, "default");

    // a prompt that throws is a decline, never an authorisation
    const threw = await runElevationGate({
      write: () => {},
      ask: async () => {
        throw new Error("tty went away");
      },
    });
    assert.equal(threw.bypassLocked, true);
  } finally {
    if (realEnv === undefined) Reflect.deleteProperty(process.env, "SUDO_USER");
    else process.env.SUDO_USER = realEnv;
  }
});

test("an UNELEVATED process passes straight through the gate", async () => {
  const realUser = process.env.SUDO_USER;
  const realUid = process.env.SUDO_UID;
  Reflect.deleteProperty(process.env, "SUDO_USER");
  Reflect.deleteProperty(process.env, "SUDO_UID");
  try {
    if (process.getuid?.() === 0) return; // running as root for real — nothing to assert
    const lines: string[] = [];
    const d = await runElevationGate({ write: (l) => lines.push(l) });
    assert.equal(d.bypassLocked, false, "a normal run must not be clamped");
    assert.deepEqual(lines, [], "a normal run must print nothing at all");
  } finally {
    if (realUser !== undefined) process.env.SUDO_USER = realUser;
    if (realUid !== undefined) process.env.SUDO_UID = realUid;
  }
});
