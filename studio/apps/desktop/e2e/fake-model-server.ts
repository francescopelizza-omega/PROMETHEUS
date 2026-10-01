// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * e2e/fake-model-server.ts — a REAL local OpenAI-compatible `/v1/chat/completions` stub.
 *
 * A real `node:http` server on a real loopback socket (127.0.0.1, ephemeral port) — not a
 * `page.route` intercept, not a mock. It exists because driving a real chat turn end to end
 * needs SOME model to answer, and the studio (this repo) has no python model runner to spawn
 * for CI. Main's REAL `ai:stream` handler (`apps/desktop/src/main/ai-ipc.ts`) makes a REAL
 * `fetch` to this server's REAL baseUrl — the exact code path a live Ollama/llama.cpp/vLLM
 * runner would answer — so everything from the request build through the SSE parse back to the
 * agent loop's tool-call dispatch is exercised for real. Only "what the model would have said"
 * is scripted.
 *
 * SSE shape mirrors `packages/core/src/ai/client.test.ts`'s stub + `ai/wire.ts`'s `OPENAI_WIRE`:
 * `data: {...}\n\n` frames carrying `choices[0].delta.{content,tool_calls}`, terminated by
 * `data: [DONE]\n\n`.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

/** The subset of the posted chat body a script needs to decide its response. */
export interface FakeChatRequest {
  model?: string;
  messages?: { role: string; content: string }[];
  tools?: unknown[];
}

/** One scripted model turn: emit a tool call, plain text, or both. */
export interface FakeModelTurn {
  toolCall?: { id?: string; name: string; args: Record<string, unknown> };
  text?: string;
}

export interface FakeModelServer {
  /** e.g. `http://127.0.0.1:54321/v1` — an OpenAI-shaped base URL. */
  baseUrl: string;
  port: number;
  /** every request body this server received, in arrival order (for assertions). */
  requests: FakeChatRequest[];
  close(): Promise<void>;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Options for `startFakeModelServer`. */
export interface FakeModelServerOptions {
  /**
   * Model ids `GET {baseUrl}/models` answers with (OpenAI `{data:[{id}]}` shape) — this is
   * what `main/ai-ipc.ts`'s `probeServedModels` (Task #18) actually hits from MAIN to expand
   * this endpoint into a picker entry. Defaults to one fixture id so a spec that only needs
   * SOME served model to unlock the composer does not have to think about it.
   */
  servedModels?: string[];
}

/**
 * Start the stub. `script(requestIndex, body)` decides EACH response — core's agent loop
 * (`packages/core/src/agent/loop.ts`) calls the model again after every tool result, so a
 * multi-round turn (tool call → hook denial → the model's next reply) is just
 * `script(0, …)`, `script(1, …)`, … in arrival order.
 *
 * Also answers `GET {baseUrl}/models` (see `FakeModelServerOptions.servedModels`) — the SAME
 * probe `main/ai-ipc.ts`'s `probeServedModels` makes for real once Task #18 routed it through
 * MAIN instead of a renderer `fetch` the production CSP refuses. A real loopback GET, not an
 * intercept: this is what lets a spec drive the Model Hub picker without reaching into the
 * renderer's `window.fetch` (the old `shimLocalModelsProbe`, removed with that bug).
 */
export async function startFakeModelServer(
  script: (requestIndex: number, body: FakeChatRequest) => FakeModelTurn,
  options: FakeModelServerOptions = {},
): Promise<FakeModelServer> {
  const servedModels = options.servedModels ?? ["e2e-fake-model"];
  const requests: FakeChatRequest[] = [];
  let count = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "GET" && /\/models\/?$/.test(url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: servedModels.map((id) => ({ id })) }));
      return;
    }
    if (req.method !== "POST" || !url.includes("/chat/completions")) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
    });
    req.on("end", () => {
      let body: FakeChatRequest;
      try {
        body = raw ? (JSON.parse(raw) as FakeChatRequest) : {};
      } catch {
        body = {};
      }
      requests.push(body);
      const idx = count;
      count += 1;
      const turn = script(idx, body);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const frames: string[] = [];
      if (turn.toolCall) {
        frames.push(
          sseFrame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: turn.toolCall.id ?? `call_${idx}`,
                      function: {
                        name: turn.toolCall.name,
                        arguments: JSON.stringify(turn.toolCall.args ?? {}),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      }
      if (turn.text) {
        frames.push(sseFrame({ choices: [{ delta: { content: turn.text } }] }));
      }
      frames.push("data: [DONE]\n\n");
      res.end(frames.join(""));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
