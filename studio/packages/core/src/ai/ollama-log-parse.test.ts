/**
 * ollama-log-parse.test.ts — checked against the real log, not an imagined one.
 *
 * Every fixture below is copied verbatim from `~/.ollama/logs/server.log` on this machine
 * (2026-09-25). That matters because the first version of this parser was written against what
 * the format *ought* to be and got two things wrong, both of which the real file settled:
 *
 *   - `general.name` is literally `n/a`, and the only recognisable model name is logged ~170
 *     lines AFTER the allocation it describes, so carrying the last name forward attributes
 *     nothing;
 *   - a split load reports one tensor buffer PER DEVICE, so the weights are a sum, not a max.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  latestPerModel,
  modelNameFrom,
  nearestModel,
  normalizeModelName,
  parseOllamaLog,
  parseSizeToBytes,
} from "./ollama-log-parse.js";

const MIB = 1024 * 1024;

/** Verbatim from server.log, trimmed to the lines that carry information. */
const REAL_LOG = `
time=2026-09-25T08:11:18.611+02:00 level=INFO source=server.go:100 msg="using llama-server for model" model=/Users/me/.ollama/models/blobs/sha256-f5ee307a2982106a6eb82b62b2c00b575c9072145a759ae4660378acda8dcf2d
srv    load_model: loading model '/Users/me/.ollama/models/blobs/sha256-f5ee307a2982106a6eb82b62b2c00b575c9072145a759ae4660378acda8dcf2d'
print_info: model type            = 35B.A3B
print_info: model params          = 35.51 B
print_info: general.name          = n/a
load_tensors: loading model tensors, this can take a while... (load_mode = none)
load_tensors:          CPU model buffer size =   272.81 MiB
load_tensors:         MTL0 model buffer size = 21171.18 MiB
llama_kv_cache: attn_rot_k = 1, n_embd_head_k_all = 256
llama_kv_cache:       MTL0 KV buffer size =  2720.00 MiB
llama_kv_cache: size = 2720.00 MiB (262144 cells,  10 layers,  1/1 seqs), K (q8_0): 1360.00 MiB, V (q8_0): 1360.00 MiB
time=2026-09-25T08:11:25.685+02:00 level=INFO source=images.go:382 msg="template selection" model=registry.ollama.ai/library/qwen3.6:latest selected=renderer_parser renderer=qwen3.5
`;

test("ANCHOR: the real log yields ollama's own numbers, exactly", () => {
  const recs = parseOllamaLog(REAL_LOG);
  assert.equal(recs.length, 1, "one allocation, one record");
  const r = recs[0];
  assert.ok(r);
  assert.equal(r.kvBytes, 2720 * MIB);
  assert.equal(r.contextTokens, 262144);
  assert.equal(r.kvLayers, 10);
  assert.equal(r.kvType, "q8_0");
  // 272.81 + 21171.18 — SUMMED. Taking the largest would silently drop 272 MiB, and on a
  // machine split across two devices would drop far more.
  assert.equal(Math.round((r.weightsBytes ?? 0) / MIB), 21444);
});

test("the model is recovered from a line AFTER the allocation, and de-registried", () => {
  const r = parseOllamaLog(REAL_LOG)[0];
  // The only usable name in this log arrives on the `template selection` line, later than the
  // kv_cache line it belongs to. A last-name-wins parser attributes nothing here.
  assert.equal(r?.model, "qwen3.6:latest");
});

test("a blob path and `n/a` are not names", () => {
  assert.equal(
    modelNameFrom(
      'msg="using llama-server for model" model=/Users/me/.ollama/models/blobs/sha256-abc',
    ),
    undefined,
  );
  assert.equal(modelNameFrom("print_info: general.name          = n/a"), undefined);
  // A `model=` field that is not a model id (no tag, no slash) is some other field.
  assert.equal(modelNameFrom("something model=true other=1"), undefined);
});

test("registry prefixes are stripped so the name matches /api/tags", () => {
  assert.equal(normalizeModelName("registry.ollama.ai/library/qwen3.6:latest"), "qwen3.6:latest");
  assert.equal(normalizeModelName("library/gemma4:12b"), "gemma4:12b");
  assert.equal(normalizeModelName('"qwen3.6:latest"'), "qwen3.6:latest");
  // A private registry keeps its prefix: there it IS part of the identity.
  assert.equal(
    normalizeModelName("gpu-box.lan:5000/team/model:v2"),
    "gpu-box.lan:5000/team/model:v2",
  );
});

test("the `MTL0 KV buffer size` line is not mistaken for the cache summary", () => {
  // It reports the same 2720 MiB but carries no cell count, so it cannot be re-scaled and must
  // not create a second, context-less record.
  const only = "llama_kv_cache:       MTL0 KV buffer size =  2720.00 MiB\n";
  assert.deepEqual(parseOllamaLog(only), []);
});

test("attribution is bounded — an allocation far from any name stays unattributed", () => {
  const names = [{ at: 0, model: "a:1" }];
  assert.equal(nearestModel(names, 10), "a:1");
  assert.equal(nearestModel(names, 5000), undefined, "not captured by an unrelated load");
});

test("attribution picks the NEAREST name in either direction", () => {
  const names = [
    { at: 0, model: "far:1" },
    { at: 100, model: "near:1" },
    { at: 400, model: "other:1" },
  ];
  assert.equal(nearestModel(names, 120), "near:1");
  assert.equal(nearestModel(names, 380), "other:1");
});

test("sizes parse in every unit llama.cpp prints", () => {
  assert.equal(parseSizeToBytes("2720.00", "MiB"), 2720 * MIB);
  assert.equal(parseSizeToBytes("1", "GiB"), 1024 * MIB);
  assert.equal(parseSizeToBytes("512", "KiB"), 512 * 1024);
  assert.equal(parseSizeToBytes("1", "MB"), MIB, "the non-binary spelling means the same here");
  assert.equal(parseSizeToBytes("nope", "MiB"), null);
});

test("latestPerModel keeps only rows that can be re-scaled, newest per model", () => {
  const recs = parseOllamaLog(`${REAL_LOG}${REAL_LOG}`);
  assert.equal(recs.length, 2, "two loads in the file");
  const latest = latestPerModel(recs);
  assert.equal(latest.length, 1, "but one row per model");
  assert.ok((latest[0]?.atLine ?? 0) > (recs[0]?.atLine ?? 0), "and it is the later one");
});

test("a record without a cell count is dropped by latestPerModel", () => {
  assert.deepEqual(latestPerModel([{ model: "m:1", kvBytes: 100, atLine: 1 }]), []);
});

test("an empty or junk log yields no records rather than throwing", () => {
  assert.deepEqual(parseOllamaLog(""), []);
  assert.deepEqual(parseOllamaLog("hello\nworld\n"), []);
});
