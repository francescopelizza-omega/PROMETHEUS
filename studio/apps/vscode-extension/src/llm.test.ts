/**
 * llm.test.ts — the VS Code host's `LLMClient` adapter now runs the preamble dispatch pipeline.
 *
 * Regression guard for the diagnosed gap: `AGENT_TOOL_DISCIPLINE` and the pre-write-recheck
 * checklist previously reached this host only via a hand-paraphrased literal baked into
 * `VSCODE_SYSTEM_PROMPT` — now they're added, every round, by the SAME contributor pipeline the
 * CLI and desktop pane use (`agent/protocol/contributors`). This file has no `vscode` import
 * (confirmed: it only tags `surface: "vscode"` as a string), so it runs in this environment
 * without the extension-host stub the rest of this package's tests need.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AiEndpoint } from "@prometheus/core";
import type { Thread } from "@prometheus/core/agent-loop";
import { defaultTuning } from "@prometheus/core/agent-loop";
import type { ToolDef } from "@prometheus/core/agent-tools";

import { createEndpointLlmClient } from "./llm.js";

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(bytes);
    },
  });
}

const DONE_SSE = 'data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n';

const LOCAL_ENDPOINT: AiEndpoint = {
  id: "local:qwen",
  baseUrl: "http://127.0.0.1:11434/v1",
  locality: "local",
  contextWindow: 8192,
  supportsTools: false,
  model: "qwen3.6:latest",
};

const READ_TOOL: ToolDef = {
  name: "read_file",
  title: "Read file",
  description: "Read a file.",
  schema: { path: { type: "string", required: true, description: "path to read" } },
  annotations: { readOnlyHint: true },
  toArgv: () => ["read_file"],
};

function capturingFetch(sse: string): {
  fetch: typeof globalThis.fetch;
  body: () => { messages?: { role: string; content: string }[] };
} {
  let captured: { messages?: { role: string; content: string }[] } = {};
  const fetch = (async (_url: string, init?: { body?: string }) => {
    captured = JSON.parse(init?.body ?? "{}");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: streamFromString(sse),
      headers: new Headers(),
      async text() {
        return "";
      },
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { fetch, body: () => captured };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const t of it) out.push(t);
  return out;
}

test("createEndpointLlmClient: the outgoing message carries tool-discipline + pre-write-recheck", async () => {
  const { fetch, body } = capturingFetch(DONE_SSE);
  const llm = createEndpointLlmClient({ endpoint: LOCAL_ENDPOINT, fetch });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  await collect(
    llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), [READ_TOOL]),
  );
  const system = body().messages?.find((m) => m.role === "system");
  assert.ok(system, "no system message was sent");
  assert.match(system?.content ?? "", /printing does nothing on disk/);
  assert.match(system?.content ?? "", /Before calling write_file or propose_edit/);
  assert.match(system?.content ?? "", /read_file/);
});

/**
 * The autostart gate is OPT-IN (`ensureOllamaRunningFn` omitted by default) for the same reason
 * ai-ipc.test.ts's desktop siblings require it: every test in this file drives a single-shape
 * mocked `fetch`, and a default-on probe would consume one of those calls (miscounting) and,
 * the moment it read as "unreachable", fall through to REAL shell-outs from inside a unit test.
 */
test("createEndpointLlmClient: ollama autostart is never attempted unless ensureOllamaRunningFn is passed", async () => {
  const { fetch } = capturingFetch(DONE_SSE);
  const llm = createEndpointLlmClient({ endpoint: LOCAL_ENDPOINT, fetch });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  // No throw, no extra fetch call consumed — the single mocked response above is enough for
  // the real request to complete normally.
  const events = await collect(
    llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), [READ_TOOL]),
  );
  assert.ok(events.length > 0);
});

test("createEndpointLlmClient: ollama autostart fires once, with the endpoint's OWN model, when injected", async () => {
  const { fetch } = capturingFetch(DONE_SSE);
  let seenModelId: string | undefined = "not called";
  let calls = 0;
  const llm = createEndpointLlmClient({
    endpoint: LOCAL_ENDPOINT,
    fetch,
    ensureOllamaRunningFn: async (opts) => {
      calls += 1;
      seenModelId = opts?.modelId;
      return { started: false };
    },
  });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  // Two turns on the SAME client: `resolveClient` memoises, so the gate must run exactly once.
  await collect(llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), [READ_TOOL]));
  await collect(llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), [READ_TOOL]));
  assert.equal(calls, 1, "the gate must run once per client, not once per turn");
  assert.equal(seenModelId, LOCAL_ENDPOINT.model, "the already-picked model must never be swapped");
});

test("createEndpointLlmClient: lmstudio autostart fires for a port-1234 endpoint, exactly the way ollama's does", async () => {
  const { fetch } = capturingFetch(DONE_SSE);
  let seenModelId: string | undefined = "not called";
  let ollamaCalls = 0;
  const llm = createEndpointLlmClient({
    endpoint: { ...LOCAL_ENDPOINT, baseUrl: "http://127.0.0.1:1234/v1", model: "qwen2.5-coder" },
    fetch,
    ensureOllamaRunningFn: async () => {
      ollamaCalls += 1;
      return { started: false };
    },
    ensureLmStudioRunningFn: async (opts) => {
      seenModelId = opts?.modelId;
      return { started: false };
    },
  });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  await collect(llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), [READ_TOOL]));
  assert.equal(seenModelId, "qwen2.5-coder");
  assert.equal(ollamaCalls, 0, "an LM Studio endpoint must never start Ollama");
});

test("createEndpointLlmClient: NEITHER autostart fires for an unmatched local endpoint (e.g. vLLM) — regression guard", async () => {
  // A prior version of the dispatch used a two-way ternary (ollama vs "everything else"), which
  // silently routed an UNMATCHED runner id (no LOCAL_RUNNERS entry owns this port) into the
  // Ollama branch. Neither must ever fire for a runner this extension doesn't know.
  const { fetch } = capturingFetch(DONE_SSE);
  let ollamaCalls = 0;
  let lmstudioCalls = 0;
  const llm = createEndpointLlmClient({
    endpoint: { ...LOCAL_ENDPOINT, baseUrl: "http://127.0.0.1:8000/v1" },
    fetch,
    ensureOllamaRunningFn: async () => {
      ollamaCalls += 1;
      return { started: false };
    },
    ensureLmStudioRunningFn: async () => {
      lmstudioCalls += 1;
      return { started: false };
    },
  });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  await collect(llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), [READ_TOOL]));
  assert.equal(ollamaCalls, 0);
  assert.equal(lmstudioCalls, 0);
});

test("createEndpointLlmClient: NEITHER autostart fires for a REMOTE endpoint on a runner's port", async () => {
  // `runnerForBaseUrl` matches by port, so a LAN Ollama on the standard port used to resolve to
  // the ollama runner and spawn `ollama serve` + a detached watchdog on THIS machine — for a
  // request that was always going to another host. Pointing the editor at a beefier box is a
  // first-class use of a local-first product, and on this machine an unrequested model server is
  // the documented memory-exhaustion path.
  const { fetch } = capturingFetch(DONE_SSE);
  let ollamaCalls = 0;
  let lmstudioCalls = 0;
  const llm = createEndpointLlmClient({
    endpoint: { ...LOCAL_ENDPOINT, baseUrl: "http://192.168.1.50:11434/v1" },
    fetch,
    ensureOllamaRunningFn: async () => {
      ollamaCalls += 1;
      return { started: false };
    },
    ensureLmStudioRunningFn: async () => {
      lmstudioCalls += 1;
      return { started: false };
    },
  });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  await collect(llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), [READ_TOOL]));
  assert.equal(ollamaCalls, 0, "a remote host is not ours to start a server for");
  assert.equal(lmstudioCalls, 0);
});

test("createEndpointLlmClient: a resource-ceiling refusal is reported as such, and stays retryable", async () => {
  // The launch guard declining a cold start is a deliberate refusal, not a broken install. The
  // reason used to be discarded, so the request went out to a dead endpoint and surfaced as
  // "no model found … start a local runner" — the one thing the user must not do at the ceiling.
  const { fetch } = capturingFetch(DONE_SSE);
  let calls = 0;
  const llm = createEndpointLlmClient({
    endpoint: LOCAL_ENDPOINT,
    fetch,
    ensureOllamaRunningFn: async () => {
      calls += 1;
      // clears on the second attempt, so the memo must not have latched the rejection
      return calls === 1
        ? { started: false, reason: "resource-ceiling" as const, resourceReason: "RAM at 94%" }
        : { started: false };
    },
  });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  await assert.rejects(
    () => collect(llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), [READ_TOOL])),
    /resource ceiling \(RAM at 94%\)/,
  );
  // the memo was dropped, so the next message re-probes rather than replaying the rejection
  await collect(llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), [READ_TOOL]));
  assert.equal(calls, 2, "the refusal is retryable — a second turn samples the guard again");
});

/**
 * Regression: `turn()`'s `tuning` parameter used to be unused entirely (`_tuning`) — VS Code
 * never sent an effort tier as a request parameter, and the `effort-text` textual fallback
 * (for a model whose mechanism can't express the tier, or has none at all) was permanently
 * dead code regardless of what the user asked for.
 */
test("createEndpointLlmClient: a requested effort tier reaches the outgoing system message as text when the model has no working mechanism", async () => {
  const { fetch, body } = capturingFetch(DONE_SSE);
  const llm = createEndpointLlmClient({ endpoint: LOCAL_ENDPOINT, fetch });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  await collect(
    llm.turn(thread, { ...defaultTuning({ provider: "local", modelId: "qwen" }), effort: "high" }, [
      READ_TOOL,
    ]),
  );
  const system = body().messages?.find((m) => m.role === "system");
  assert.ok(system);
  assert.match(
    system?.content ?? "",
    /Think carefully before you answer/,
    "the high-effort nudge never reached the outgoing system message",
  );
});

test("createEndpointLlmClient: with NO tools, no preamble is sent at all", async () => {
  const { fetch, body } = capturingFetch(DONE_SSE);
  const llm = createEndpointLlmClient({ endpoint: LOCAL_ENDPOINT, fetch });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  await collect(llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), []));
  const system = body().messages?.find((m) => m.role === "system");
  assert.equal(system, undefined, "a preamble was sent despite an empty tool list");
});

/**
 * Regression: this host used to have NO inactivity protection at all — it drives every request
 * through `@prometheus/core`'s shared `stream()`/`chat()`, which had no watchdog of its own, so a
 * cold-loading or wedged local model hung the extension forever. A real-elapsed-time × 1000
 * compressed clock lets this use a fully realistic, floor-respecting `idleTimeoutMs` (30s) while
 * actually firing in milliseconds of test time — see `agent-runtime.test.ts`'s identical helper.
 */
function compressedClock(speedup: number) {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * speedup,
    setTimeoutFn: (cb: () => void, ms: number) => setTimeout(cb, ms / speedup),
    clearTimeoutFn: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  };
}

function hangingFetch(): typeof globalThis.fetch {
  return (async (_url: string, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
  }) as typeof globalThis.fetch;
}

test("createEndpointLlmClient: a response that never arrives PAUSES, not an indefinite hang", async () => {
  const clock = compressedClock(1000); // a real "30s" idle window fires in ~30ms of test time
  const llm = createEndpointLlmClient({
    endpoint: LOCAL_ENDPOINT,
    fetch: hangingFetch(),
    idleTimeoutMs: 30_000,
    idleWatchdogNow: clock.now,
    idleWatchdogSetTimeout: clock.setTimeoutFn,
    idleWatchdogClearTimeout: clock.clearTimeoutFn,
  });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  const started = Date.now();
  const turns = await collect(
    llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), []),
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 2000,
    `expected a bounded pause well under 2s of real time, took ${elapsed}ms`,
  );
  assert.ok(
    turns.some((t) => (t as { kind: string }).kind === "paused"),
    "expected a paused turn, not an indefinite hang",
  );
  assert.ok(!turns.some((t) => (t as { kind: string }).kind === "final"));
});

/**
 * `hangingFetch()` above only exercises the PRE-CONNECT path (the `doFetch` call itself never
 * resolves) — verification pass #2 flagged that this never reaches the mid-stream `reader.read()`
 * catch inside `@prometheus/core`'s `ai/client.ts` `stream()`, which is the more representative
 * "cold-loading local model" scenario: headers/connection succeed promptly, then the SSE body
 * goes silent while the model loads/generates. This stub connects successfully and streams one
 * real chunk, then hangs — a real `pull()` that never resolves except on abort, mirroring how a
 * genuinely open, already-reading stream behaves.
 */
function partialThenHangingFetch(chunk: string): typeof globalThis.fetch {
  return (async (_url: string, init?: { signal?: AbortSignal }) => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(chunk));
        init?.signal?.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
      pull() {
        return new Promise<void>(() => {
          /* never enqueue further, never close on its own */
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof globalThis.fetch;
}

test("createEndpointLlmClient: a connection that streams once then goes silent mid-read PAUSES too, not just a pre-connect hang", async () => {
  const clock = compressedClock(1000);
  const llm = createEndpointLlmClient({
    endpoint: LOCAL_ENDPOINT,
    fetch: partialThenHangingFetch('data: {"choices":[{"delta":{"content":"partial"}}]}\n'),
    idleTimeoutMs: 30_000,
    idleWatchdogNow: clock.now,
    idleWatchdogSetTimeout: clock.setTimeoutFn,
    idleWatchdogClearTimeout: clock.clearTimeoutFn,
  });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  const started = Date.now();
  const turns = await collect(
    llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), []),
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 2000,
    `expected a bounded pause well under 2s of real time, took ${elapsed}ms`,
  );
  const text = turns
    .filter((t) => (t as { kind: string }).kind === "text")
    .map((t) => (t as { text: string }).text)
    .join("");
  assert.equal(text, "partial", "text streamed before the mid-stream pause must not be discarded");
  assert.ok(
    turns.some((t) => (t as { kind: string }).kind === "paused"),
    "expected a paused turn from the mid-stream hang",
  );
});

/* ── V4: inline <think> must not reach this host's transcript either ────────*/

/** An R1-class endpoint: the capability table gives `deepseek-r1` a `reasoningTag`. */
const R1_ENDPOINT: AiEndpoint = { ...LOCAL_ENDPOINT, model: "deepseek-r1:8b" };

/** SSE frames carrying `parts` as successive content deltas. */
function sseParts(parts: readonly string[]): string {
  return `${parts
    .map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}`)
    .join("\n")}\ndata: [DONE]\n`;
}

test("createEndpointLlmClient: an R1-style model's inline thinking never becomes the answer", async () => {
  // This host has no thinking channel, so the deliberation is DROPPED — which beats leaking
  // it, because leaking prefixes the answer AND feeds the thought to the tool-call scanner.
  // The tag is split across deltas because that is what a real stream does.
  const { fetch } = capturingFetch(
    sseParts(["<thi", "nk>weighing it up</think>", "The answer is 4."]),
  );
  const llm = createEndpointLlmClient({ endpoint: R1_ENDPOINT, fetch });
  const thread: Thread = { messages: [{ role: "user", content: "2+2" }] };
  const turns = await collect(
    llm.turn(thread, defaultTuning({ provider: "local", modelId: "deepseek-r1:8b" }), []),
  );
  const text = turns
    .filter((t) => t.kind === "text")
    .map((t) => (t as { text: string }).text)
    .join("");
  assert.equal(text, "The answer is 4.", "the deliberation leaked into the answer");
});

test("createEndpointLlmClient: a model with NO reasoning tag streams byte-identically", async () => {
  const { fetch } = capturingFetch(sseParts(["plain <think>not special</think> answer"]));
  const llm = createEndpointLlmClient({ endpoint: LOCAL_ENDPOINT, fetch });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  const turns = await collect(
    llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), []),
  );
  const text = turns
    .filter((t) => t.kind === "text")
    .map((t) => (t as { text: string }).text)
    .join("");
  assert.equal(text, "plain <think>not special</think> answer");
});

test("createEndpointLlmClient: the CURRENT turn's abort signal reaches the request", async () => {
  /**
   * The client is built ONCE per session rebuild, so a per-turn `signal` could never be supplied
   * at construction — and nothing in production set one. The abort therefore reached
   * `runAgentTurn` but never the model stream: core's loop only tests `aborted` between rounds
   * and before a tool call, so for a text-only answer "Cancel Current Turn" was not observed
   * until the model had finished streaming the whole round, and the HTTP request was never
   * aborted at all. On a slow local model that is minutes of un-cancellable output.
   *
   * `getSignal` is read fresh per turn, which is what makes a long-lived client cancellable.
   */
  let sawSignal: AbortSignal | undefined;
  let linkedDuringRequest: boolean | undefined;
  let abortNow: (() => void) | undefined;
  const fetch = (async (_url: string, init?: { signal?: AbortSignal; body?: string }) => {
    sawSignal = init?.signal;
    // Linkage can only be observed WHILE the request is open: core combines the caller's signal
    // with its own idle-watchdog controller and tears that down when the stream ends, so an
    // abort fired afterwards proves nothing.
    if (init?.signal && abortNow) {
      const before = init.signal.aborted;
      abortNow();
      linkedDuringRequest = !before && init.signal.aborted;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: streamFromString(DONE_SSE),
      headers: new Headers(),
      async text() {
        return "";
      },
    } as unknown as Response;
  }) as typeof globalThis.fetch;

  const controller = new AbortController();
  abortNow = () => controller.abort();
  const llm = createEndpointLlmClient({
    endpoint: LOCAL_ENDPOINT,
    fetch,
    getSignal: () => controller.signal,
  });
  const thread: Thread = { messages: [{ role: "user", content: "hi" }] };
  await collect(llm.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), []));

  assert.ok(sawSignal, "the request was made with no abort signal — Cancel cannot stop it");
  assert.equal(
    linkedDuringRequest,
    true,
    "the request's signal is not linked to the turn's — Cancel cannot stop generation",
  );

  // and it is re-read each turn, so a LATER turn is cancellable too rather than only the first
  const second = new AbortController();
  linkedDuringRequest = undefined;
  abortNow = () => second.abort();
  const llm2 = createEndpointLlmClient({
    endpoint: LOCAL_ENDPOINT,
    fetch,
    getSignal: () => second.signal,
  });
  await collect(llm2.turn(thread, defaultTuning({ provider: "local", modelId: "qwen" }), []));
  assert.equal(linkedDuringRequest, true, "a later turn's signal was not wired");
});
