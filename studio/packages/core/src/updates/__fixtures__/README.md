# Captured registry responses

Real bytes, fetched from `registry.ollama.ai` on 2026-09-28. They are fixtures rather than
literals in the test because **the digest is the SHA-256 of the exact body** — a re-serialised
or re-indented copy hashes differently, and a fixture that cannot reproduce the real digest
would silently prove nothing.

| file | request | sha256 of the body |
|---|---|---|
| `gemma4-12b.manifest.json` | `GET /v2/library/gemma4/manifests/12b` | `4eb23ef187e2c5462566d6a1d3bbbc2f1346d0b4327cbb66d58fffbcc9b2b05c` |
| `qwen3.6-latest.manifest.json` | `GET /v2/library/qwen3.6/manifests/latest` | `096fdbd02fe620fc10cbeb6537e080f8041aece851e5d696aed024d4f70f2e47` |

`gemma4-12b`'s digest is the one that matters most: it is **identical** to what `/api/tags`
reported for the installed `gemma4:12b` on the machine this was captured on. That equality is
the entire basis for checking updates without pulling, and `model-registry.test.ts` asserts it.

`qwen3.6-latest.config.json` is the config blob that manifest points at
(`GET /v2/library/qwen3.6/blobs/sha256:99afa5bb…`, after following the 307 to the CDN). It
carries `requires: "0.30.0"` — the minimum ollama version, which is why an update is not offered
without checking it.

Both were served with `Accept: application/vnd.docker.distribution.manifest.v2+json`; the
endpoint `vary`s on that header and returns a different manifest shape without it.

---

## These files must never be reformatted — and once were

On 2026-09-28 a routine `biome check --write` over `packages/core/src/updates/` pretty-printed
both manifests. Biome formats JSON too, and nothing in the directory said not to. The digests
became:

```
gemma4  2d94275852db8a96…   (should be 4eb23ef187e2c546…)
qwen3.6 bc1eb4049b48a450…   (should be 096fdbd02fe620fc…)
```

Four tests failed immediately — including the one whose comment says *"any reformatting changes
it"* — so the damage was visible within seconds rather than shipping as a feature that reported
every model on every machine as out of date.

Two things came out of it:

1. `biome.json` now ignores `**/__fixtures__/**`, alongside the `**/contract/golden/**` entry
   that exists for exactly the same reason: bytes captured from somewhere else are evidence,
   not source code, and a formatter has no business touching them.
2. It is a live demonstration of why `manifestDigest` takes raw bytes rather than a parsed
   object. The tool that broke these was not a network hiccup or a malicious input — it was the
   repo's own formatter, run deliberately.

If a digest here ever fails to match, re-fetch rather than edit:

```bash
curl -sS -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
  https://registry.ollama.ai/v2/library/gemma4/manifests/12b \
  -o packages/core/src/updates/__fixtures__/gemma4-12b.manifest.json
```
