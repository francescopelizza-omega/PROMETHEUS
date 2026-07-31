/**
 * settings-bundle.test.ts — PURE settings-sync bundle + STRUCTURAL redaction (APP-095).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { mcpHost } from "@prometheus/core";
import {
  buildSettingsBundle,
  redactConnector,
  serializeBundle,
  validateSettingsBundle,
} from "./settings-bundle.js";

type McpServerConfig = mcpHost.McpServerConfig;

function stdioCfg(env?: Record<string, string>): McpServerConfig {
  return {
    id: "gh",
    label: "GitHub",
    transport: {
      kind: "stdio",
      command: "gh-mcp",
      args: ["serve"],
      ...(env ? { env } : {}),
      cwd: "/w",
    },
    enabled: true,
    scope: "global",
    autoApprove: ["read_file"],
    source: "manual",
    health: "unknown",
  };
}
function httpCfg(headers?: Record<string, string>): McpServerConfig {
  return {
    id: "remote",
    label: "Remote",
    transport: {
      kind: "http",
      url: "https://mcp.example.com/rpc",
      ...(headers ? { headers } : {}),
    },
    enabled: false,
    scope: "global",
    autoApprove: [],
    source: "manual",
    health: "unknown",
  };
}

test("redactConnector drops transport.env (stdio) + transport.headers (http)", () => {
  const s = redactConnector(stdioCfg({ TOKEN: "SECRET_ENV_123" }));
  assert.equal(s.transport.kind, "stdio");
  assert.equal(s.transport.command, "gh-mcp");
  assert.equal(s.transport.cwd, "/w");
  assert.ok(!("env" in s.transport), "env stripped");
  const h = redactConnector(httpCfg({ Authorization: "Bearer SECRET_TOK" }));
  assert.equal(h.transport.url, "https://mcp.example.com/rpc");
  assert.ok(!("headers" in h.transport), "headers stripped");
});

test("redactConnector strips credentials embedded in the http url (userinfo + secret query)", () => {
  const cfg = httpCfg();
  (cfg.transport as { url: string }).url =
    "https://user:SECRET_TOK@mcp.example.com/rpc?api_key=AKIA_LEAK&x=1";
  const r = redactConnector(cfg);
  const url = r.transport.kind === "http" ? r.transport.url : "";
  assert.equal(url.includes("SECRET_TOK"), false, "userinfo token stripped");
  assert.equal(url.includes("AKIA_LEAK"), false, "api_key query stripped");
  assert.ok(url.includes("mcp.example.com/rpc"), "host/path preserved");
  assert.ok(url.includes("x=1"), "non-secret query preserved");
});

test("the SERIALIZED bundle contains zero secret bytes (redaction assertion, AC4)", () => {
  const bundle = buildSettingsBundle({
    keymap: { base: "vscode", overrides: [{ command: "x", keys: "cmd+k", source: "user" }] },
    themes: [{ id: "mine", name: "Mine", base: "dark", tokens: { "bg-app": "#000000" } }],
    connectors: [
      stdioCfg({ TOKEN: "SECRET_ENV_123", API_KEY: "AKIA_LEAK" }),
      httpCfg({ Authorization: "Bearer SECRET_TOK_XYZ", "X-Api-Key": "KEY_LEAK" }),
    ],
  });
  const bytes = serializeBundle(bundle);
  for (const secret of ["SECRET_ENV_123", "AKIA_LEAK", "SECRET_TOK_XYZ", "KEY_LEAK"]) {
    assert.equal(bytes.includes(secret), false, `bundle leaked ${secret}`);
  }
  // the non-secret fields ARE present.
  assert.ok(bytes.includes("gh-mcp"));
  assert.ok(bytes.includes("https://mcp.example.com/rpc"));
});

test("validateSettingsBundle round-trips a good bundle; rejects a malformed one", () => {
  const good = serializeBundle(
    buildSettingsBundle({ keymap: { base: "vscode", overrides: [] }, themes: [], connectors: [] }),
  );
  const parsed = validateSettingsBundle(good);
  assert.ok(!("error" in parsed));
  assert.equal((parsed as { version: number }).version, 1);
  assert.ok("error" in validateSettingsBundle("not json{"));
  assert.ok("error" in validateSettingsBundle("[]"));
  assert.ok("error" in validateSettingsBundle('{"version":1,"themes":[],"connectors":[]}')); // no keymap
  assert.ok(
    "error" in
      validateSettingsBundle(
        '{"version":1,"keymap":{"base":"x","overrides":{}},"themes":[],"connectors":[]}',
      ),
  );
});
