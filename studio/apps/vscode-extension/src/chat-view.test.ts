/**
 * chat-view.test.ts — a re-created webview must not lose the conversation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ChatViewProvider } from "./chat-view.js";

/** A `WebviewView`-shaped double that records everything posted to it. */
function fakeView() {
  const received: Record<string, unknown>[] = [];
  return {
    received,
    webview: {
      options: {},
      html: "",
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (m: Record<string, unknown>) => {
        received.push(m);
        return true;
      },
      asWebviewUri: (u: unknown) => u,
      cspSource: "vscode-webview:",
    },
    onDidDispose: () => ({ dispose() {} }),
  };
}

const provider = () =>
  new ChatViewProvider({
    extensionUri: { fsPath: "/tmp/ext" } as never,
    session: () => undefined,
    unavailableReason: () => "no session",
  } as never);

test("a re-created webview is replayed the transcript it missed", async () => {
  /**
   * VS Code disposes and re-creates a webview when the user collapses the sidebar or switches
   * activity-bar container. `resolveWebviewView` set fresh HTML and posted nothing, so the panel
   * came back EMPTY — while `posted`, the provider's own 1000-message history, held the whole
   * conversation the entire time. Worse, a turn running at that moment had already sent its
   * `busy` message to the old view, so the new one never showed the spinner and the user saw an
   * idle, empty panel while the model was still working.
   */
  const p = provider();
  const first = fakeView();
  p.resolveWebviewView(first as never);

  p.post({ type: "user", text: "what does this repo do?" });
  p.post({ type: "delta", text: "It is a CLI." });
  p.post({ type: "busy", busy: true });
  assert.equal(first.received.length, 3, "precondition: the first view got the messages");

  const second = fakeView();
  p.resolveWebviewView(second as never);
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(second.received.length > 0, "the re-created webview got an EMPTY transcript");
  const kinds = second.received.map((m) => m.type);
  assert.deepEqual(
    kinds,
    ["user", "delta", "busy"],
    `replayed the wrong thing: ${kinds.join(",")}`,
  );
  // the busy state survives, so a turn still running keeps its spinner
  assert.equal(second.received.at(-1)?.busy, true);
});

test("replay does not double-post to a view that is already live", async () => {
  // self-validating: resolving is the only replay trigger, so an ordinary post after it must
  // arrive exactly once.
  const p = provider();
  const view = fakeView();
  p.resolveWebviewView(view as never);
  await new Promise((r) => setTimeout(r, 20));
  p.post({ type: "delta", text: "once" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(view.received.filter((m) => m.text === "once").length, 1);
});

test("the busy state survives the 1000-message backlog cap and is re-asserted on replay", async () => {
  // regression: `busy:true` is posted ONCE at the start of a turn; a long streaming turn posts
  // far more than 1000 deltas after it, and the cap splices the marker off the FRONT. A webview
  // re-created mid-turn (collapse the sidebar / switch container) replayed a backlog with no
  // `busy` in it and came back UNLOCKED while the model was still working.
  const p = provider();
  p.post({ type: "busy", busy: true });
  for (let i = 0; i < 1200; i++) p.post({ type: "delta", text: `chunk ${i}` });
  assert.equal(
    p.posted.some((m) => m.type === "busy"),
    false,
    "the fixture must actually evict the marker, or this test proves nothing",
  );
  const view = fakeView();
  p.resolveWebviewView(view as never);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    view.received.some((m) => m.type === "busy" && m.busy === true),
    "the re-created panel was left unlocked during a running turn",
  );
});

test("a panel replayed while IDLE is not falsely marked busy", async () => {
  const p = provider();
  p.post({ type: "busy", busy: true });
  p.post({ type: "busy", busy: false });
  const view = fakeView();
  p.resolveWebviewView(view as never);
  await new Promise((r) => setTimeout(r, 20));
  const last = [...view.received].reverse().find((m) => m.type === "busy");
  assert.equal(last?.busy, false, "an idle panel was replayed as busy");
});
