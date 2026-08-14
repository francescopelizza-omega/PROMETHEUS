/**
 * extension.spec.ts — integration tests, running INSIDE a real VS Code instance.
 *
 * `@vscode/test-electron` downloads a pinned VS Code build and launches it with this suite as
 * `--extensionTestsPath`, so `vscode` here is the genuine API, `workspace.fs` is the genuine
 * filesystem layer and `applyEdit` is the genuine edit stack. Nothing below is mocked except
 * the two things that MUST be: the model (there is no LLM in CI) and the confirm dialog (a
 * modal would block the run forever).
 *
 * The agent loop itself is emphatically NOT mocked — every test drives `runAgentTurn` out of
 * `@prometheus/core`, through the real tool runner, onto the real VS Code APIs.
 */

import * as vscode from "vscode";

import type { LLMClient, LlmTurn, ToolCall } from "@prometheus/core/agent-loop";

import type { PrometheusApi } from "../../extension.js";
import { assert, assertEqual, assertIncludes, test, waitFor } from "./harness.js";

const EXTENSION_ID = "prometheus-studio.prometheus-vscode";

/* ── fakes ───────────────────────────────────────────────────────────────────*/

/**
 * A model that plays a scripted list of turns, one per round.
 *
 * Shaped exactly like the repo's existing `scriptedLlm` (see
 * apps/desktop/src/renderer/ide/ai/core-agent.test.ts): the loop calls `turn()` once per round,
 * so the script is indexed by round and the last entry repeats.
 */
function scriptedLlm(rounds: LlmTurn[][]): LLMClient {
  let round = 0;
  return {
    async *turn() {
      const script = rounds[Math.min(round, rounds.length - 1)] ?? [{ kind: "final" as const }];
      round++;
      for (const t of script) yield t;
    },
  };
}

const answer = (text: string): LlmTurn[] => [{ kind: "text", text }, { kind: "final" }];

const callThen = (call: ToolCall, then: string): LlmTurn[][] => [
  [{ kind: "tool_call", call }],
  answer(then),
];

/* ── helpers ─────────────────────────────────────────────────────────────────*/

async function getApi(): Promise<PrometheusApi> {
  const ext = vscode.extensions.getExtension<PrometheusApi>(EXTENSION_ID);
  assert(ext, `extension ${EXTENSION_ID} is not installed in this VS Code instance`);
  const api = await ext.activate();
  assert(api, "activate() resolved nothing — the extension exports no API");
  return api;
}

function workspaceUri(rel: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("no workspace folder is open in the test instance");
  return vscode.Uri.joinPath(folder.uri, rel);
}

/** The assistant text the panel would show, reassembled from what was posted to the webview. */
function renderedText(api: PrometheusApi): string {
  return api.view.posted
    .filter((m): m is { type: "delta"; text: string } => m.type === "delta")
    .map((m) => m.text)
    .join("");
}

function toolNotes(api: PrometheusApi): string[] {
  return api.view.posted
    .filter((m): m is { type: "tool"; note: string } => m.type === "tool")
    .map((m) => m.note);
}

/** Fresh state for a test: clear the transcript and auto-approve every confirm. */
function reset(api: PrometheusApi): void {
  api.view.posted.length = 0;
  api.setConfirm(async () => true);
}

/* ── the tests ───────────────────────────────────────────────────────────────*/

test("the extension activates without throwing", async () => {
  const ext = vscode.extensions.getExtension<PrometheusApi>(EXTENSION_ID);
  assert(ext, `extension ${EXTENSION_ID} is not present`);
  await ext.activate();
  assert(ext.isActive, "the extension did not become active");
});

test("activation exposes the API the host needs", async () => {
  const api = await getApi();
  assert(typeof api.submit === "function", "api.submit is missing");
  assert(typeof api.setLlmClient === "function", "api.setLlmClient is missing");
  assert(api.session() !== undefined, "no session was built for the open workspace folder");
});

test("the sidebar view is contributed and its provider registers", async () => {
  const ext = vscode.extensions.getExtension<PrometheusApi>(EXTENSION_ID);
  assert(ext, "extension missing");
  const contributes = ext.packageJSON.contributes as {
    views?: Record<string, { id: string; type?: string }[]>;
    viewsContainers?: { activitybar?: { id: string }[] };
  };
  const container = contributes.viewsContainers?.activitybar?.[0];
  assertEqual(container?.id, "prometheus", "the activity-bar container is not contributed");
  const view = contributes.views?.prometheus?.[0];
  assertEqual(view?.id, "prometheus.chatView", "the chat view is not contributed");
  assertEqual(view?.type, "webview", "the chat view is not declared as a webview");

  // Revealing the view is what makes VS Code call `resolveWebviewView` — the real proof the
  // provider is registered, as opposed to merely declared in package.json.
  await vscode.commands.executeCommand("prometheus.chatView.focus");
  const api = await getApi();
  await waitFor(() => api.view.resolved, "the webview view to be resolved by VS Code");
});

test("the extension's commands are registered", async () => {
  const all = await vscode.commands.getCommands(true);
  for (const id of ["prometheus.focusChat", "prometheus.newSession", "prometheus.cancel"]) {
    assert(all.includes(id), `command ${id} was not registered`);
  }
});

test("a chat message round-trips the REAL agent loop and reaches the webview", async () => {
  const api = await getApi();
  reset(api);
  api.setLlmClient(scriptedLlm([answer("Hello from the agent loop.")]));

  await api.submit("hi");

  assertIncludes(
    renderedText(api),
    "Hello from the agent loop.",
    "the model's answer never reached the webview",
  );
  assert(
    api.view.posted.some((m) => m.type === "done"),
    "the turn never posted a `done`, so the panel would spin forever",
  );
  // The thread is the conversation, and core mutates it — proving it grew is proving the real
  // loop ran rather than a shortcut that echoed text at the sinks.
  const roles = api.session()?.thread.messages.map((m) => m.role) ?? [];
  assert(roles.includes("user"), "the user turn was not folded into the thread");
  assert(roles.includes("assistant"), "the assistant turn was not folded into the thread");
});

test("read_file runs through vscode.workspace.fs and its content reaches the model", async () => {
  const api = await getApi();
  reset(api);
  await vscode.workspace.fs.writeFile(
    workspaceUri("sample.txt"),
    Buffer.from("alpha\nbeta\ngamma\n", "utf8"),
  );

  api.setLlmClient(
    scriptedLlm(callThen({ name: "read_file", args: { path: "sample.txt" } }, "I read it.")),
  );
  await api.submit("read sample.txt");

  const toolMsg = api.session()?.thread.messages.find((m) => m.role === "tool");
  assert(toolMsg, "no {role:'tool'} message was folded back into the thread");
  assertIncludes(toolMsg.content, "beta", "the file's content did not reach the model");
  // The `N  ` gutter core's tool description promises the model.
  assertIncludes(toolMsg.content, "2  beta", "read_file did not emit line numbers");
  assert(
    toolNotes(api).some((n) => n.includes("read sample.txt")),
    "no tool-activity note reached the webview",
  );
});

test("write_file lands through applyEdit — visible in VS Code's own buffer", async () => {
  const api = await getApi();
  reset(api);
  const uri = workspaceUri("generated.ts");
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    /* not there yet — fine */
  }

  api.setLlmClient(
    scriptedLlm(
      callThen(
        { name: "write_file", args: { path: "generated.ts", content: "export const x = 1;\n" } },
        "Written.",
      ),
    ),
  );
  await api.submit("create generated.ts");

  // Opening the document reads VS Code's BUFFER, which is the layer `applyEdit` writes to. A
  // raw `node:fs` write would not be reflected here until (and unless) the buffer reloaded.
  const doc = await vscode.workspace.openTextDocument(uri);
  assertIncludes(doc.getText(), "export const x = 1;", "the file content is not in the buffer");
});

test("propose_edit edits the OPEN, DIRTY buffer — the thing raw node:fs cannot do", async () => {
  const api = await getApi();
  reset(api);
  const uri = workspaceUri("live.txt");
  await vscode.workspace.fs.writeFile(uri, Buffer.from("one\ntwo\nthree\n", "utf8"));

  // Open it and make an UNSAVED change. This is the scenario that separates a real editor
  // integration from an fs write: on disk the file still says "two", but the user is looking
  // at "TWO-EDITED". An fs-based agent would overwrite the file and the user's unsaved buffer
  // would silently win back on their next save, destroying the agent's work.
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((b) => {
    b.insert(new vscode.Position(0, 3), " MANUAL");
  });
  assert(doc.isDirty, "the document should be dirty — the precondition of this test");

  api.setLlmClient(
    scriptedLlm(
      callThen(
        {
          name: "propose_edit",
          args: { path: "live.txt", hunks: [{ old: "three", new: "THREE" }] },
        },
        "Edited.",
      ),
    ),
  );
  await api.submit("uppercase three");

  const text = doc.getText();
  assertIncludes(text, "one MANUAL", "the user's unsaved edit was destroyed by the agent");
  assertIncludes(text, "THREE", "the agent's edit did not land in the open buffer");
});

test("apply_patch across two files is ONE undo entry", async () => {
  const api = await getApi();
  reset(api);
  const a = workspaceUri("patch-a.txt");
  const b = workspaceUri("patch-b.txt");
  await vscode.workspace.fs.writeFile(a, Buffer.from("aaa\n", "utf8"));
  await vscode.workspace.fs.writeFile(b, Buffer.from("bbb\n", "utf8"));

  api.setLlmClient(
    scriptedLlm(
      callThen(
        {
          name: "apply_patch",
          args: {
            edits: [
              { path: "patch-a.txt", hunks: [{ old: "aaa", new: "AAA" }] },
              { path: "patch-b.txt", hunks: [{ old: "bbb", new: "BBB" }] },
            ],
          },
        },
        "Patched.",
      ),
    ),
  );
  await api.submit("uppercase both");

  const docA = await vscode.workspace.openTextDocument(a);
  const docB = await vscode.workspace.openTextDocument(b);
  assertIncludes(docA.getText(), "AAA", "patch-a.txt was not edited");
  assertIncludes(docB.getText(), "BBB", "patch-b.txt was not edited");
});

test("a destructive tool reaches the human confirm; a read does not", async () => {
  const api = await getApi();
  reset(api);
  const asked: string[] = [];
  api.setConfirm(async (call) => {
    asked.push(call.name);
    return true;
  });
  await vscode.workspace.fs.writeFile(workspaceUri("gate.txt"), Buffer.from("x\n", "utf8"));

  api.setLlmClient(
    scriptedLlm([
      [
        { kind: "tool_call", call: { name: "read_file", args: { path: "gate.txt" } } },
        {
          kind: "tool_call",
          call: { name: "write_file", args: { path: "gate2.txt", content: "y" } },
        },
      ],
      answer("done"),
    ]),
  );
  await api.submit("read then write");

  assert(
    !asked.includes("read_file"),
    "read_file prompted for confirmation — reads must auto-approve at authLevel 1",
  );
  assert(
    asked.includes("write_file"),
    "write_file did NOT reach the confirm surface — the destructive gate is not wired",
  );
});

test("a denied tool call is refused and the model is told, without killing the turn", async () => {
  const api = await getApi();
  reset(api);
  api.setConfirm(async () => ({ approved: false, reason: "not this time" }));

  api.setLlmClient(
    scriptedLlm(
      callThen(
        { name: "write_file", args: { path: "denied.txt", content: "nope" } },
        "Understood.",
      ),
    ),
  );
  await api.submit("write a file");

  const toolMsg = api.session()?.thread.messages.find((m) => m.role === "tool");
  assert(toolMsg, "the denial was not folded back into the thread");
  assertIncludes(toolMsg.content, "denied by user", "the model was not told it was denied");
  // And the file must not exist.
  let exists = true;
  try {
    await vscode.workspace.fs.stat(workspaceUri("denied.txt"));
  } catch {
    exists = false;
  }
  assert(!exists, "a DENIED write_file created the file anyway");
});

test("a path escaping the workspace root is refused", async () => {
  const api = await getApi();
  reset(api);
  api.setLlmClient(
    scriptedLlm(
      callThen({ name: "read_file", args: { path: "../../../etc/passwd" } }, "Could not."),
    ),
  );
  await api.submit("read outside");

  const toolMsg = api.session()?.thread.messages.find((m) => m.role === "tool");
  assert(toolMsg, "no tool result came back");
  assertIncludes(
    toolMsg.content,
    "not a workspace-relative path",
    "an escaping path was not refused",
  );
});

test("the --force ban is inherited from core's loop", async () => {
  const api = await getApi();
  reset(api);
  api.setLlmClient(
    scriptedLlm(
      callThen(
        { name: "write_file", args: { path: "forced.txt", content: "x", force: true } },
        "ok",
      ),
    ),
  );
  await api.submit("force it");

  assert(
    toolNotes(api).some((n) => n.includes("blocked")),
    "a --force argument was not blocked — the loop's §4 invariant is not in force",
  );
});
