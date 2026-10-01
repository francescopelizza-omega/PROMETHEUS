// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/redact.ts — scrub secrets out of anything the agent is about to READ.
 *
 * Phase 1 of full_wrapper_compose §8. The threat is specific and easy to under-rate: every
 * byte a system tool returns is folded into the model's thread, and when the active endpoint
 * is a cloud one that thread LEAVES THE MACHINE. A single `read_file(".env")` or a `git diff`
 * that happens to touch a credentials file is an exfiltration, and it is silent.
 *
 * Two mechanisms, deliberately not one:
 *
 *   1. `isSecretPath` REFUSES whole files whose path says "this is a credential"
 *      (`~/.ssh/id_ed25519`, `.env.production`, `*.pem`, `~/.aws/credentials`). Refusal, not
 *      redaction — a key file that survived the redactor with one byte intact is still a key
 *      file, and "I scrubbed it" is a worse answer than "I will not read it".
 *   2. `redactSecrets` masks credential SHAPES inside output we do read, because secrets do
 *      not stay in files named like secrets — they appear in `git diff`, in a stack trace, in
 *      `ps` output, in a Makefile.
 *
 * This is a MITIGATION, not a guarantee, and it is written to be honest about that: the
 * shapes below are the ones with a documented prefix, plus assignment-shaped lines. A secret
 * with no distinguishing shape (a 20-char password in a config) will not be caught, which is
 * exactly why mechanism 1 exists alongside it.
 *
 * PURE: no IO, no node builtins, no regex backtracking hazards (every pattern is anchored or
 * bounded). Unit-tested against real token shapes.
 */

/** What a redaction replaced — kept in the output so the model knows something was there. */
export type SecretKind =
  | "openai-key"
  | "anthropic-key"
  | "github-token"
  | "gitlab-token"
  | "slack-token"
  | "google-key"
  | "huggingface-token"
  | "npm-token"
  | "aws-access-key-id"
  | "aws-secret"
  | "private-key-block"
  | "jwt"
  | "bearer"
  | "url-credentials"
  | "assignment";

/** One masked span (the report the caller can surface: "3 secrets redacted"). */
export interface Redaction {
  kind: SecretKind;
  /** how many characters the original occupied (never the value itself). */
  length: number;
}

export interface RedactResult {
  text: string;
  redactions: Redaction[];
}

/** The placeholder written in place of a secret. Distinctive so tests + humans can spot it. */
export function mask(kind: SecretKind): string {
  return `«redacted:${kind}»`;
}

/**
 * The credential shapes with a documented, unambiguous prefix.
 *
 * Ordered most-specific first: `sk-ant-` must beat the generic `sk-` rule, or an Anthropic key
 * gets labelled as an OpenAI one. Every pattern bounds its match length rather than using a
 * bare `+` on a broad class — an unbounded charset here is how a redactor becomes a
 * quadratic-backtracking DoS on a large file.
 */
const SHAPES: { kind: SecretKind; re: RegExp }[] = [
  // Anthropic: sk-ant-api03-… (and older sk-ant-…)
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,120}\b/g },
  // OpenAI: sk-…, sk-proj-…
  { kind: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,120}\b/g },
  // GitHub PATs / OAuth / server / refresh tokens — the ghX_ family is fixed-shape.
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g },
  // GitHub fine-grained PAT
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{16,64}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,200}\b/g },
  { kind: "google-key", re: /\bAIza[A-Za-z0-9_-]{30,40}\b/g },
  { kind: "huggingface-token", re: /\bhf_[A-Za-z0-9]{30,60}\b/g },
  { kind: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,45}\b/g },
  // AWS: AKIA/ASIA are the access-key-ID shapes (the SECRET is caught by `assignment`).
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // A whole PEM block, header to footer, including the newlines between.
  {
    kind: "private-key-block",
    re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g,
  },
  // JWT: three base64url segments. Bounded, and requires the leading `eyJ` header shape so a
  // hyphenated identifier cannot masquerade as one.
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,2000}\b/g,
  },
  // `Authorization: Bearer <token>` — the token, not the header name.
  { kind: "bearer", re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,2000}/g },
  // https://user:password@host — the password, in a URL, in a remote, in a log.
  {
    kind: "url-credentials",
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]{1,64}:[^\s/@]{1,200}@/gi,
  },
];

/**
 * Assignments whose VALUE is a secret regardless of the value's own shape.
 *
 * This is the rule that catches the long tail — a 12-character database password has no
 * prefix to match on, but `DB_PASSWORD=` in front of it is unambiguous.
 *
 * It is also the rule that WILL over-redact if written loosely, and over-redaction is the
 * failure mode that gets a redactor switched off. `const tokens = source.split(/\s+/)` is
 * not a credential, and an earlier version of this rule masked it, because `tokens` contains
 * `token` and the right-hand side is "a value". So both halves are constrained:
 *
 *   NAME  — must be an ENV-style all-caps identifier (`DB_PASSWORD`), a quoted object key
 *           (`"apiKey"`), or camelCase whose keyword is a SUFFIX (`accessToken`). Plain
 *           `tokens` fails all three: the keyword is not a suffix, it is a prefix of a plural.
 *   VALUE — an unquoted value may not contain `(`, `)`, `/` or a backtick, because those mean
 *           "this is an expression, not a literal". A QUOTED value may contain anything
 *           (an AWS secret legitimately contains `/`), since the quotes prove it is a literal.
 */
const KEYWORD =
  "API[_-]?KEY|SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|CREDENTIALS?|PRIVATE[_-]?KEY|ACCESS[_-]?KEY";

/** `DB_PASSWORD=…` / `AWS_SECRET_ACCESS_KEY = "…"` — the env-var shape. */
const ENV_ASSIGNMENT = new RegExp(
  `\\b([A-Z0-9_]*(?:${KEYWORD})[A-Z0-9_]*)(\\s*[:=]\\s*)(?:(")([^"\\n]{4,4000})"|(')([^'\\n]{4,4000})'|([^\\s"'\`(),;]{4,4000}))`,
  // Case-SENSITIVE on purpose. With `i` this rule matched `tokens = source.split` — the
  // all-caps shape IS the signal that says "environment variable", and dropping it turns a
  // precise rule into the loose one the doc comment above warns about.
  "g",
);

/** `"apiKey": "…"` / `accessToken: "…"` — the object-property shape, keyword as a SUFFIX. */
const PROP_ASSIGNMENT = new RegExp(
  `(["']?[A-Za-z0-9_]*(?:${KEYWORD})["']?)(\\s*[:=]\\s*)(?:(")([^"\\n]{4,4000})"|(')([^'\\n]{4,4000})'|([^\\s"'\`(),;]{4,4000}))`,
  // Case-INSENSITIVE, because `apiKey` and `accessToken` are the real-world spellings. What
  // keeps `tokens` out is not the case but the ANCHOR: the keyword must be the LAST thing in
  // the name (optionally followed by a closing quote), so a plural or a compound like
  // `tokenizer` cannot match.
  "gi",
);

/**
 * Mask every credential shape in `text`.
 *
 * Idempotent: running it twice produces the same string (the mask itself contains no shape
 * that matches). Order matters — the prefix shapes run first so a `sk-…` inside an
 * `OPENAI_API_KEY=` assignment is reported as an `openai-key` rather than a generic one.
 */
export function redactSecrets(text: string): RedactResult {
  if (!text) return { text: "", redactions: [] };
  const redactions: Redaction[] = [];
  let out = text;

  for (const { kind, re } of SHAPES) {
    out = out.replace(new RegExp(re.source, re.flags), (m) => {
      redactions.push({ kind, length: m.length });
      // url-credentials keeps the scheme+user prefix so the remote stays identifiable.
      if (kind === "url-credentials") {
        const at = m.lastIndexOf("@");
        const colon = m.lastIndexOf(":", at);
        return `${m.slice(0, colon + 1)}${mask(kind)}@`;
      }
      return mask(kind);
    });
  }

  const maskAssignment = (
    m: string,
    name: string,
    sep: string,
    dq: string | undefined,
    dv: string | undefined,
    sq: string | undefined,
    sv: string | undefined,
    bare: string | undefined,
  ): string => {
    const quote = dq ?? sq ?? "";
    const value = dv ?? sv ?? bare ?? "";
    // already masked by a shape rule above — do not double-report or re-wrap.
    if (!value || value.startsWith("«redacted:")) return m;
    redactions.push({ kind: "assignment", length: value.length });
    return `${name}${sep}${quote}${mask("assignment")}${quote}`;
  };
  out = out.replace(ENV_ASSIGNMENT, maskAssignment);
  out = out.replace(PROP_ASSIGNMENT, maskAssignment);

  return { text: out, redactions };
}

/** Convenience: the masked text only. */
export function redact(text: string): string {
  return redactSecrets(text).text;
}

/* ── whole-file refusals ─────────────────────────────────────────────────────*/

/**
 * Paths whose CONTENT is a credential by definition.
 *
 * Matched against the POSIX-normalised path with `\` folded to `/`, so a Windows path cannot
 * slip past a `/`-anchored pattern. Patterns are deliberately broad — a false refusal costs
 * the agent one tool call and a clear message; a false accept costs the user a key.
 */
/**
 * Every dot-DIRECTORY pattern matches the directory ITSELF as well as its contents (`(?:$|/…)`).
 *
 * They used to require a trailing slash, so only paths INSIDE matched and the directory as an
 * operand did not: `cp -r ~/.docker dk` was permitted, and `read_file dk/config.json` then
 * returned the registry credential verbatim. Measured — both `cp -r ~/.docker dk` and
 * `cp -r ~/.docker/ dk` were allowed, so the trailing slash was not the deciding factor; the
 * directory simply never matched. The same escape existed for `.ssh`, `.aws` and `.gnupg`, and
 * `.docker`/`.kube` matched only one specific file inside them.
 *
 * Broadened to the whole directory in keeping with this file's stated policy — "a false refusal
 * costs the agent one tool call and a clear message; a false accept costs the user a key". The
 * `.ssh` carve-out for `known_hosts`/`config` is preserved.
 */
const SECRET_PATHS: { re: RegExp; why: string }[] = [
  { re: /(^|\/)\.ssh(?:$|\/(?!known_hosts|config$))/i, why: "SSH private-key directory" },
  { re: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?!\.pub$)/i, why: "SSH private key" },
  { re: /\.(?:pem|key|p12|pfx|jks|keystore)$/i, why: "private key / keystore" },
  { re: /(^|\/)\.aws(?:$|\/)/i, why: "AWS credentials directory" },
  { re: /(^|\/)\.(?:netrc|pgpass|my\.cnf)$/i, why: "credential file" },
  { re: /(^|\/)\.env(?:\.[A-Za-z0-9_-]+)?$/i, why: "environment file (.env)" },
  { re: /(^|\/)(?:credentials|secrets?)(?:\.(?:json|ya?ml|toml|ini))?$/i, why: "credential file" },
  { re: /(^|\/)\.gnupg(?:$|\/)/i, why: "GnuPG keyring" },
  { re: /(^|\/)\.docker(?:$|\/)/i, why: "Docker registry credentials" },
  { re: /(^|\/)\.npmrc$/i, why: "npm registry token" },
  { re: /(^|\/)\.git-credentials$/i, why: "stored git credentials" },
  { re: /(^|\/)\.kube(?:$|\/)/i, why: "Kubernetes cluster credentials" },
];

/** Why this path is refused, or null when it is safe to read. */
export function secretPathReason(path: string): string | null {
  const p = (path ?? "").replace(/\\/g, "/");
  if (!p) return null;
  for (const { re, why } of SECRET_PATHS) {
    if (re.test(p)) return why;
  }
  return null;
}

/** True when the agent must NOT read this path at all (see secretPathReason for the why). */
export function isSecretPath(path: string): boolean {
  return secretPathReason(path) !== null;
}

/** The refusal message a tool returns instead of the content. */
export function secretRefusal(path: string, why: string, verb = "read"): string {
  return [
    `refused to ${verb} ${path}: ${why}.`,
    "Tool output is folded into the model's context and may be sent to a cloud endpoint, so",
    "credential files are never read. Ask the human to paste only the specific value you need.",
    // A MOVE is refused for the same reason a read is: renaming `.env` to `notes.txt` and
    // reading that back was a complete bypass of this refusal, and the redactor behind it only
    // masks values long enough to look like secrets.
    verb === "read" ? "" : "Renaming it would defeat this refusal, so the move is refused too.",
  ]
    .filter(Boolean)
    .join(" ");
}
