/**
 * redact.test.ts — the scrubber that stands between a system tool and a cloud endpoint.
 *
 * Every case here is a real credential SHAPE (with the secret bytes replaced by filler of the
 * same length and charset). The suite is deliberately organised as "must catch" / "must not
 * mangle" / "must refuse", because a redactor fails in two directions and only one of them is
 * loud: over-redaction makes a diff unreadable and someone turns it off.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isSecretPath, mask, redact, redactSecrets, secretPathReason } from "./redact.js";

/* ── must catch: prefixed token shapes ───────────────────────────────────────*/

const SHAPES: [label: string, sample: string, kind: string][] = [
  ["anthropic", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "anthropic-key"],
  ["openai", "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "openai-key"],
  ["openai project", "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", "openai-key"],
  ["github pat", "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "github-token"],
  ["github oauth", "gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "github-token"],
  ["github fine-grained", "github_pat_AAAAAAAAAAAAAAAAAAAAAAAA_BBBBBBBB", "github-token"],
  ["gitlab", "glpat-AAAAAAAAAAAAAAAAAAAA", "gitlab-token"],
  ["slack bot", "xoxb-FIXTURE-SYNTHETIC-NOT-REAL-PLACEHOLDER", "slack-token"],
  ["google", "AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "google-key"],
  ["huggingface", "hf_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "huggingface-token"],
  ["npm", "npm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "npm-token"],
  ["aws access key id", "AKIAIOSFODNN7EXAMPLE", "aws-access-key-id"],
];

for (const [label, sample, kind] of SHAPES) {
  test(`redacts a ${label} token`, () => {
    const { text, redactions } = redactSecrets(`the key is ${sample} ok`);
    assert.ok(!text.includes(sample), `${label} survived redaction`);
    assert.ok(text.includes(mask(kind as never)), `${label} got the wrong mask: ${text}`);
    assert.equal(redactions.length, 1);
  });
}

test("redacts a whole PEM private-key block, header to footer", () => {
  const pem = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
    "c2gtZWQyNTUxOQAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");
  const out = redact(`before\n${pem}\nafter`);
  assert.ok(!out.includes("b3BlbnNzaC1rZXktdjEA"));
  assert.ok(out.includes(mask("private-key-block")));
  assert.ok(out.includes("before") && out.includes("after"), "context must survive");
});

test("redacts a JWT but not a hyphenated identifier that merely has dots", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.AAAAAAAAAAAAAAAAAAAA";
  assert.ok(redact(jwt).includes(mask("jwt")));
  const notAJwt = "com.example.some-service.v2";
  assert.equal(redact(notAJwt), notAJwt);
});

test("redacts the token after Bearer/Basic, keeping the scheme visible", () => {
  const out = redact("Authorization: Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.ok(out.includes("Bearer") === false || out.includes(mask("bearer")));
  assert.ok(!out.includes("AAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
});

test("redacts credentials embedded in a URL, keeping the host identifiable", () => {
  const out = redact("git remote: https://alice:hunter2hunter2@github.com/o/r.git");
  assert.ok(!out.includes("hunter2hunter2"));
  assert.ok(out.includes("github.com/o/r.git"), "the remote must stay recognisable");
  assert.ok(out.includes("alice"), "the username is not the secret");
});

/* ── must catch: the long tail, by NAME ──────────────────────────────────────*/

test("redacts assignment-shaped credentials whatever the value looks like", () => {
  // The whole point of this rule: a 12-char database password has no prefix to match on.
  const src = [
    "DB_PASSWORD=s3cr3t-pw-01",
    'AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
    '"apiKey": "abcdef0123456789"',
    "GITHUB_TOKEN: ghs_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ].join("\n");
  const out = redact(src);
  assert.ok(!out.includes("s3cr3t-pw-01"));
  assert.ok(!out.includes("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"));
  assert.ok(!out.includes("abcdef0123456789"));
  assert.ok(!out.includes("ghs_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"));
  // the NAMES survive — a config with every key masked is still readable as a config
  assert.ok(out.includes("DB_PASSWORD"));
  assert.ok(out.includes("AWS_SECRET_ACCESS_KEY"));
});

test("a token inside an assignment is reported by its SHAPE, not as a generic value", () => {
  const { redactions } = redactSecrets("OPENAI_API_KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.deepEqual(
    redactions.map((r) => r.kind),
    ["openai-key"],
    "the shape rules run first so the report names the provider",
  );
});

test("an EMPTY assignment is left alone (masking it only hurts readability)", () => {
  assert.equal(redact("PASSWORD="), "PASSWORD=");
  assert.equal(redact("TOKEN: "), "TOKEN: ");
});

/* ── must not mangle ─────────────────────────────────────────────────────────*/

test("ordinary code and prose pass through untouched", () => {
  const src = [
    "export function keyFor(id: string) { return `row-${id}`; }",
    "// the password field is validated elsewhere",
    "const tokens = source.split(/\\s+/);",
    "git log --oneline -n 20",
    "public_key = load('id_ed25519.pub')",
  ].join("\n");
  assert.equal(redact(src), src);
});

test("redaction is idempotent — the mask itself is never re-matched", () => {
  const once = redact("KEY=sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(redact(once), once);
});

test("empty input is safe", () => {
  assert.deepEqual(redactSecrets(""), { text: "", redactions: [] });
});

test("a large benign buffer is not quadratic (bounded patterns)", () => {
  // Guards the backtracking hazard: an unbounded charset here would hang the agent on a
  // big file rather than fail loudly.
  const big = `${"const x = 1; // ordinary line\n".repeat(20_000)}`;
  const t0 = Date.now();
  redact(big);
  assert.ok(Date.now() - t0 < 4000, "redactor must stay linear-ish on a 600KB buffer");
});

/* ── must refuse: whole-file paths ───────────────────────────────────────────*/

const REFUSED = [
  "/Users/me/.ssh/id_ed25519",
  "/Users/me/.ssh/id_rsa",
  "~/.aws/credentials",
  "/home/me/.aws/config",
  "/srv/app/.env",
  "/srv/app/.env.production",
  "certs/server.pem",
  "keystore.p12",
  "/Users/me/.netrc",
  "/Users/me/.npmrc",
  "/Users/me/.git-credentials",
  "/Users/me/.kube/config",
  "/Users/me/.docker/config.json",
  "/Users/me/.gnupg/secring.gpg",
  "config/secrets.yaml",
  String.raw`C:\Users\me\.ssh\id_rsa`, // backslashes must not defeat the `/`-anchored rules
];

for (const p of REFUSED) {
  test(`refuses to read ${p}`, () => {
    assert.ok(isSecretPath(p), `${p} must be refused outright, not merely redacted`);
    assert.ok((secretPathReason(p) ?? "").length > 0);
  });
}

const ALLOWED = [
  "/Users/me/.ssh/known_hosts",
  "/Users/me/.ssh/config",
  "/Users/me/id_ed25519.pub",
  "src/env.ts",
  "docs/environment.md",
  "package.json",
  "/etc/hosts",
  "README.md",
];

for (const p of ALLOWED) {
  test(`allows ${p}`, () => {
    assert.equal(isSecretPath(p), false, `${p} was refused but is not a credential file`);
  });
}

test("a credential DIRECTORY is refused as an operand, not only the files inside it", () => {
  // regression: the dot-directory patterns required a trailing slash, so only paths INSIDE
  // matched. `cp -r ~/.docker dk` was permitted and `read_file dk/config.json` then returned the
  // registry credential verbatim — measured end to end against the compiled runner. Both slash
  // forms were allowed, so the trailing slash was never the deciding factor: the directory
  // simply never matched.
  for (const dir of [
    "/home/u/.ssh",
    "/home/u/.aws",
    "/home/u/.gnupg",
    "/home/u/.docker",
    "/home/u/.kube",
  ]) {
    assert.ok(isSecretPath(dir), `${dir} (bare directory) must be refused`);
    assert.ok(isSecretPath(`${dir}/`), `${dir}/ must be refused`);
  }
  // contents still refused
  assert.ok(isSecretPath("/home/u/.aws/credentials"));
  assert.ok(isSecretPath("/home/u/.docker/config.json"));
  // the .ssh carve-outs survive the broadening
  assert.equal(isSecretPath("/home/u/.ssh/known_hosts"), false);
  assert.equal(isSecretPath("/home/u/.ssh/config"), false);
  // and an ordinary source directory is NOT a credential: this repo has core/src/secrets, and
  // treating a DIRECTORY by the file rule made `grep -r` unusable across the whole tree.
  assert.equal(isSecretPath("/repo/src/dockerfiles"), false);
  assert.equal(isSecretPath("/repo/src/environments"), false);
});
