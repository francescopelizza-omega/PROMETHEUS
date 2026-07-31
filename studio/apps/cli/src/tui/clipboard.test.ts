/**
 * clipboard.test.ts — the pure OSC 52 sequence builder (CLI-068): plain / tmux-wrapped /
 * over-limit / empty branches. Write-only; no read-back path is built or tested.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { OSC52_MAX_B64, copyReplyStatus, lastAssistantReply, osc52Sequence } from "./clipboard.js";

const ESC = "\x1b";
const ST = `${ESC}\\`;

test("osc52Sequence: plain text → ESC]52;c;<b64> ST (spec ST terminator) (CLI-068)", () => {
  const { sequence } = osc52Sequence("hello");
  const b64 = Buffer.from("hello", "utf8").toString("base64"); // "aGVsbG8="
  assert.equal(sequence, `${ESC}]52;c;${b64}${ST}`);
  assert.ok(sequence?.endsWith(ST)); // ST, not BEL
});

test("osc52Sequence: TMUX → DCS passthrough with EVERY inner ESC doubled (CLI-068)", () => {
  const { sequence } = osc52Sequence("hi", { tmux: true });
  const b64 = Buffer.from("hi", "utf8").toString("base64");
  // ESC P tmux; <inner with ESC doubled> ESC \
  const expected = `${ESC}Ptmux;${ESC}${ESC}]52;c;${b64}${ESC}${ESC}\\${ST}`;
  assert.equal(sequence, expected);
  // the classic failure: no un-doubled ESC survives inside the DCS body.
  const body = sequence?.slice(`${ESC}Ptmux;`.length, -ST.length) ?? "";
  assert.ok(!/(^|[^\x1b])\x1b([^\x1b])/.test(body), "every inner ESC must be doubled");
});

test("osc52Sequence: empty / whitespace → no-op (never a CLEAR sequence) (CLI-068)", () => {
  assert.deepEqual(osc52Sequence(""), { sequence: null, reason: "empty" });
  assert.deepEqual(osc52Sequence("   \n\t "), { sequence: null, reason: "empty" });
});

test("osc52Sequence: over the base64 cap → no-op warn, not a truncated half-sequence (CLI-068)", () => {
  // ~56KB of text base64-encodes to ~75KB > OSC52_MAX_B64.
  const big = "x".repeat(OSC52_MAX_B64); // base64 grows 4/3 → well over the cap
  const r = osc52Sequence(big);
  assert.equal(r.sequence, null);
  assert.equal(r.reason, "too-large");
  // just under the cap still emits.
  const ok = osc52Sequence("y".repeat(1000));
  assert.ok(ok.sequence?.startsWith(`${ESC}]52;c;`));
});

test("osc52Sequence: no TMUX → plain (no DCS wrapper) (CLI-068)", () => {
  const { sequence } = osc52Sequence("z", { tmux: false });
  assert.ok(!sequence?.startsWith(`${ESC}Ptmux;`));
});

test("lastAssistantReply picks the newest assistant message; copyReplyStatus writes raw (CLI-068)", () => {
  const hist = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "first" },
    { role: "user", content: "again" },
    { role: "assistant", content: "LATEST reply" },
  ];
  assert.equal(lastAssistantReply(hist), "LATEST reply");
  assert.equal(lastAssistantReply([]), "");
  let written = "";
  const status = copyReplyStatus("copy me", false, (s) => {
    written = s;
  });
  assert.match(status, /sent to terminal clipboard/);
  assert.ok(written.startsWith("\x1b]52;c;"));
  // empty → nothing written, honest status.
  let w2 = "";
  const empty = copyReplyStatus("", false, (s) => {
    w2 = s;
  });
  assert.match(empty, /nothing to copy/);
  assert.equal(w2, "");
});
