# Studio Python Sidecar — JSON Envelope Contract (C7)

The thin Python layer the Studio MAIN/engine-bridge launches alongside `prometheus.py`.
Every invocation is `python3 <sidecar.py> <verb> [args...]` and prints **exactly one JSON
object** to **stdout** (sorted keys, `ensure_ascii=False`). Every human/diagnostic line
goes to **stderr**. The process exit code is `0` on success, `2` on a fail-closed error
(derived from the envelope by `_envelope.emit`/`fail`).

Invocation parallels the engine contract (C2): the bridge passes argv verbatim with
`shell:false`, recovers the **last** JSON-object line from stdout, and treats a
missing / unparseable / timed-out object as an **error → fail-closed BLOCK** (C5).

## Common envelope shape

| field | type | meaning |
|---|---|---|
| `ok` | bool | `true` success · `false` error |
| `command` | string | the verb name (e.g. `env.list`) |
| `error` | string | present only when `ok:false` |
| `_exit` | int | present on errors (2) and explicit overrides |
| …verb fields… | — | per-verb payload (below) |

**Error envelope (any verb):** `{"ok": false, "command": "<verb>", "error": "<msg>", "_exit": 2}`
plus any verb-specific context fields. An unknown/missing verb yields the same with
`command` = the bad verb (or the program name when no verb was given).

**Gating note (C4/C5):** these sidecars never decide "safe". Any install/download is gated
upstream by the engine-bridge **nemesis** runner. Mutating verbs only execute under
`--confirm`; without it they return a non-destructive `plan` for the bridge to preview/gate.

---

## envmgr.py

| verb | args | success output shape (one object) |
|---|---|---|
| `env.list` | — | `{ok, command:"env.list", environments:[{name,path,kind:venv\|conda\|system,python_version,packages_count}], count, conda_available}` |
| `env.use` | `<env>` | `{ok, command:"env.use", env, path, kind, bin, python, python_version, env_vars:{VIRTUAL_ENV?,CONDA_PREFIX?,PATH_PREPEND}}` |
| `pkg.list` | `<env>` | `{ok, command:"pkg.list", env, path, packages:[{name,version,...}], count}` (runs `pip list --format=json` in the target env) |
| `cuda.info` | — | `{ok, command:"cuda.info", gpu, driver, cuda_version, nvidia_smi:bool, nvcc:bool, torch_cuda:bool\|null, available:bool}` (any field may be `null`) |
| `conda.env-list` | — | `{ok, command:"conda.env-list", conda_available:bool, environments:[{name,path,kind:"conda",python_version,packages_count}], count}` |
| `template.list` | — | `{ok, command:"template.list", templates:[{id,label,python,packages,path?}], count, source:"bundled"\|"builtin"}` |
| `env.create` | `<path-or-name> [--python V] [--conda] [--confirm]` | without `--confirm`: `{ok, command, planned:true, plan:[argv], kind, target, note}` · with: `{ok, command, executed:true, plan, returncode, stdout_tail, kind, target}` |
| `env.delete` | `<env> [--confirm]` | plan/executed envelope, `kind`, `target` (refuses non-venv paths) |
| `env.clone` | `<src-env> <dest-path> [--confirm] [--force]` | venv: freeze src → create dest → **GATED** reinstall of the frozen set; conda: `conda create --clone`. plan/gated-install envelope, `src`, `dest`, `kind` |
| `env.export` | `<env> [--to FILE]` | `{ok, command:"env.export", env, path, kind, format:"requirements.txt"\|"environment.yml", requirements:[...], count, written_to}` (read-only: pip freeze / `conda env export`) |
| `env.import` | `--file requirements.txt\|environment.yml --name N [--python V] [--confirm] [--force]` | creates the env then **GATED-installs** the requirement set (yml → `conda env create -f`). plan without `--confirm` |
| `env.doctor` | `<env>` | `{ok, command:"env.doctor", env, path, kind, health:"ok"\|"degraded"\|"broken", checks:{interpreter_runs, pip_resolves, config_parses, cuda_visible:bool\|null}}` (read-only) |
| `pkg.install` | `<env> <spec...> [--confirm] [--force]` | **GATED** (§6): stage→scan→install. see gated envelope below |
| `pkg.update` | `<env> <spec...> [--confirm] [--force]` | **GATED** single-pkg `install --upgrade` |
| `pkg.upgrade` | `<env> [<spec...>] [--confirm] [--force]` | **GATED** bulk upgrade; with no specs, resolves `pip list --outdated` |
| `pkg.uninstall` | `<env> <pkg...> [--confirm]` | plan/executed envelope, `env`, `packages` (pip `uninstall -y`) — NOT a fetch, no gate |
| `pkg.remove` | `<env> <pkg...> [--confirm]` | as `pkg.uninstall` (pin kept by the store) |
| `pkg.disable` | `<env> <pkg> [--confirm]` | reversible: renames `*.dist-info` → `*.dist-info.studio-disabled` sentinel. `{ok, executed, env, package, state:"disabled", disabled_marker}` (no fetch) |
| `pkg.enable` | `<env> <pkg> [--confirm]` | restores the sentinel-disabled package. `{ok, executed, env, package, state:"enabled", restored}` (no real fetch) |
| `cuda.torch` | `--env ENV [--index URL] [--confirm] [--force]` | **GATED** install of the CUDA/CPU `torch` wheel into the env |
| `template.commit` | `--template ID --env ENV [--confirm] [--force]` | resolves the template's default-checked packages to ONE batched **GATED** install plan |

`kind` is `venv` | `conda` | `system`. Conda verbs are no-ops/empty when `conda` is not on PATH.

### The gated install envelope (file 04 §6/§8) — `pkg.install`/`pkg.update`/`pkg.upgrade`/`env.import`/`cuda.torch`/`template.commit`

Every fetching verb routes through the spine: `pip download --no-deps` into a TEMP staging dir → **real `nemesis gate <staging>`** (`--sandbox auto --jail auto --sign --timeout 840`; fail-closed: missing/timeout/exit2/unparseable ⇒ `error` ⇒ BLOCK) → on `allow` `pip install --no-index --find-links <staging>` (the EXACT vetted bytes, no TOCTOU re-fetch).

* **no `--confirm`** → `{ok:true, command, planned:true, plan:{download, gate, install}, request, force, note}` (nothing staged/scanned/installed).
* **allow** → `{ok:true, command, installed:true, verdict:"allow", request, gate:{verdict,score,reasons,signed,recommendation,scanned_at}, stdout_tail}`.
* **warn** (no `force`) → `{ok:true, command, installed:false, needs_confirm:true, verdict:"warn", request, gate, message}` — GUI confirms, then re-runs with `--force`.
* **block/error** (no `force`) → `{ok:false, command, blocked:true, request, gate, message, _exit:2}` (the §8 blocked envelope).
* **`--force`** over a block/error/warn → installs the scanned bytes anyway and flags `forced_danger:{label, verdict, risk_score, blocking_reasons}` for audit.

The gate decision is the engine's (the real `nemesis` binary, located `$NEMESIS_BIN` → sibling PROMETHEUS root → `which('nemesis')`); this sidecar marshals the verdict, it NEVER decides "safe" (C5).

---

## modelhub.py

| verb | args | success output shape (one object) |
|---|---|---|
| `hw.scan` | — | `{ok, command:"hw.scan", os, arch, cpu:{model,logical,physical}, ram_bytes, ram_gb, gpus:[{name,vendor,vram_mb,vram_bytes,...,unified_memory}], gpu_count, unified_memory:bool, usable_weight_bytes, usable_weight_gb, usable_basis:"vram"\|"unified"\|"system-ram"\|"unknown"}` |
| `model.list` | `[dir]` (default `$PROMETHEUS_MODELS_DIR` or `~/.cache/prometheus/models`) | `{ok, command:"model.list", root, exists:bool, models:[{name,path,format,size_bytes,size_gb,quant}], count}` |
| `fit.score` | `--params <N>b` or `--size-gb <G>` ; `[--quant Q]` (default `q4_k_m`) ; `[--hw <hw.scan json>]` | `{ok, command:"fit.score", verdict:"fits"\|"tight"\|"no", quant, recommended_quant, params_b, weight_bytes, weight_gb, needed_bytes, needed_gb, usable_bytes, usable_gb, headroom_ratio, hw_basis:"provided"\|"scanned"}` |
| `model.search` | `[query] [--family F] [--kind llm\|non-llm]` | `{ok, command:"model.search", query, family, kind, results:[<catalog model>], count, catalog_version, source}` |
| `fit` | `--id <catalog id>` or `--params <N>b` ; `[--family F] [--ctx N] [--hw <json>]` | `{ok, command:"fit", id, params_b, family, ctx_len, accel, usable_gb, recommended:<Quant\|null>, ranked:[<Quant>], reasons:[str]}` |
| `download` | `--id ID [--quant L] [--source hf\|ollama\|url] [--license L] [--staged DIR] [--sha256 '{rfile:hex}'] [--force]` | no `--staged`: `{ok, planned:true, id, quant, source, stage_dir, plan:{fetch,gate,admit}, note}` · with `--staged`: the **admit** result (below) |
| `serve` | `--id ID [--quant L] [--runner llamacpp\|vllm\|ollama] [--gguf PATH] [--ctx N] [--port N] [--hw <json>] [--autostart]` | `{ok, command:"serve", profile:<ServeProfile+argv>, fit:<Quant>, note}` (pure — builds argv, does NOT spawn) |
| `endpoints` | — | LIVE `prometheus.py localai endpoints` → `{ok, command:"endpoints", local:[{name,base_url}], open_api:[{name,base_url}], count, engine}` |
| `repoint` | `--tool TOOL --base-url URL` | LIVE `localai show TOOL` → `{ok, command:"repoint", tool, base_url, patchable, recipe, proposed_env:{BASEURL:url, API_KEY:"ollama"}, referenced_env_vars, secret_policy, engine}` |

`fit.score` heuristics: weight bytes = `params_b * 1e9 * bits_per_weight / 8`; needed =
weights × 1.20 (KV-cache + runtime); `fits` if needed ≤ 80% of usable memory, `tight` if
≤ 100%, else `no`. `recommended_quant` = the largest quant in `q8_0…q2_k` that fits ≤ 80%.
Usable memory = discrete VRAM if present, else ~70% of system/unified RAM.

`fit` (the Cookbook ranked scorer, file 05 §4) is richer than `fit.score`: per-quant
`est_vram_gb = weights + kv_cache(ctx,n_layers,d_model) + overhead(accel)`; verdict
`FITS`(≤0.80) / `TIGHT`(≤1.0) / `PARTIAL`(≤1.6) / `OVERFLOW`(>1.6) of `est/budget`
(budget = usable × 0.92); caps-gating (FP8⇒needs fp8, AWQ/GPTQ⇒vLLM Marlin, Metal⇒gguf/mlx);
`recommended` = max `quality_rank` among runnable FITS/TIGHT quants, tie-break GGUF; always
explains `reasons[]`. Pure math in `fit.py`, fully offline-tested.

### The download GATE / admit envelope (file 05 §5 — the SECURITY SPINE)

`download --staged <dir>` runs the same fail-closed spine as `envmgr`'s gated install,
adapted for model weights: **stage → sha256 verify → REAL `nemesis gate <stage>` →
admit | quarantine**. The sidecar NEVER decides "safe" (C5) — it marshals the real
scanner verdict. Pickle-format weights (`*.bin/*.pt/*.ckpt`) are flagged high-risk vs
`safetensors`/`gguf` (no code execution on load).

* **allow** → `{ok:true, admitted:true, verdict:"allow", id, local_path, manifest, gate, format_risk}` (stage moved to live lib + `.prometheus_model.json` written).
* **warn** (no `force`) → `{ok:true, admitted:false, needs_confirm:true, verdict:"warn", gate, message}`.
* **block/error** (no `force`) → `{ok:false, admitted:false, blocked:true, verdict, gate, quarantined:<dir>, message, _exit:2}` (stage **quarantined**, not deleted).
* **sha256 mismatch** → BLOCK before the scan (`checksum:{ok:false, mismatches}` + quarantine).
* **`--force`** over block/error/warn → admits the scanned bytes anyway + `forced_danger:{label, verdict, risk_score, blocking_reasons}`.
* **fail-closed**: nemesis missing/timeout/unparseable/non-existent stage ⇒ `error` ⇒ BLOCK.

The gate runs the same binary + flags as the engine (`$NEMESIS_BIN` → sibling PROMETHEUS
root → `which('nemesis')`; `--sandbox auto --jail auto --sign --timeout 840`). The library
lives at `~/.prometheus/models/` (`$PROMETHEUS_MODELS_HOME` overrides): `.stage/<id>/`
in-progress, `.stage/.quarantine/` refused, `huggingface/<id>/` admitted.

`endpoints`/`repoint` are **LIVE passthroughs** — they really run `prometheus.py localai`
(the engine owns the open-model catalog + recipes) and structure its human-table output.
`repoint` writes only the non-secret base-URL + dummy `KEY=ollama` placeholder, never a
real key (the engine secret rule).

`model.search` reads the bundled catalog at `../../config/open-models.json`
(qwen3 / gpt-oss / gemma3 / llama3 / deepseek / mistral / phi + non-LLM embeddings/ASR/diffusion).

---

## repo.py — the gated arbitrary-URL GitHub repo manager (file 06 §3, feature #5a)

The ONLY arbitrary-URL clone path in Studio (pre-declared `REPO_TOOLS` still go through the
engine `apps install`). Hard-wired through the SAME security spine the engine uses for
`git_clone` plugins: clone with `_GIT_SAFE_FLAGS` into a STAGING dir → REAL `nemesis gate`
over the staged tree → promote only on allow. The sidecar NEVER decides "safe" (C5).

The repo store lives at `~/.config/prometheus/repos/` (`$PROMETHEUS_REPOS_HOME` overrides):
`index.json` (the list view), `<id>/` admitted clones, `.stage/<id>/` in-progress,
`.stage/.quarantine/` refused. The id is a filesystem-safe `owner__name` slug.

| verb | args | success output shape (one object) |
|---|---|---|
| `clone` | `--url U [--branch B] [--pin SHA] [--staged DIR] [--force]` | the GATE result (below). `--staged DIR` gates an already-cloned dir (offline/the bridge's completed fetch); without it, clones the URL itself with `_GIT_SAFE_FLAGS` then gates |
| `list` | — | `{ok, command:"list", repos:[<Repo entry>], count, index, root}` (reconciles: a vanished clone dir → `status:"missing"`) |
| `update` | `--id ID [--force]` | re-stage the new HEAD (`pull --ff-only` under safe flags; pinned repos re-gate the pinned tree, no advance) → re-gate → promote on allow. GATE result |
| `pin` | `--id ID --sha SHA [--force]` | `checkout --detach SHA` under safe flags → re-gate → promote on allow. GATE result |
| `branch` | `--id ID --branch B [--force]` | `checkout B` under safe flags → re-gate (pin cleared). GATE result |
| `rescan` | `--id ID [--gate-fresh]` | re-run `nemesis gate` over the CURRENT live tree (NO fetch). `--gate-fresh` ⇒ `PROMETHEUS_GATE_FRESH=1` ⇒ nemesis `--no-cache`. `{ok, command:"rescan", id, verdict, gate, verdict_ref, gate_fresh, status, local_path}`. Updates the index verdict ref; a block flips `status:"blocked"` |
| `remove` | `--id ID` | `{ok, command:"remove", id, removed_dir, removed_entry, local_path, found, remaining}` — drops the clone dir + index entry (idempotent: unknown id ⇒ `ok:true, found:false`) |

`_GIT_SAFE_FLAGS` is **replicated EXACTLY from `prometheus.py:1280`** so the same clone-time
TOCTOU is closed (no repo-controlled code runs before the scan):
`-c core.hooksPath=/dev/null` (no post-checkout/post-merge/... hook), `-c core.fsmonitor=`
(no fsmonitor helper), `-c protocol.ext.allow=never` (no `ext::` submodule transport), and
`clone --depth 1 --no-recurse-submodules`. Confirmed against the live `git 2.50.1`.

### The clone/update/pin/branch GATE envelope

Runs `stage (safe flags) → REAL nemesis gate <stage> → promote | quarantine`, fail-closed:

* **allow** → `{ok:true, command, promoted:true, verdict:"allow", id, url, owner, name, branch, commit, local_path, gate:{verdict,score,reasons,signed,recommendation,scanned_at}, verdict_ref:{verdict,score,commit,signedAt,findingsRef,reasons,recommendation}, entry:<Repo index entry>, message}` (stage moved → live + index entry + verdict ref bound to the commit).
* **warn** (no `force`) → `{ok:true, command, promoted:false, needs_confirm:true, status:"warn", verdict:"warn", gate, verdict_ref, message}` — kept STAGED (NOT promoted); GUI confirms, re-run with `force:true`.
* **block/error** (no `force`) → `{ok:false, command, promoted:false, blocked:true, status:"blocked", verdict, gate, verdict_ref, quarantined:<dir>, message, _exit:2}` (staging **quarantined**, not deleted).
* **`--force`** over block/error/warn → promotes the scanned tree anyway + `forced_danger:{label, verdict, risk_score, blocking_reasons}` for audit.
* **fail-closed**: nemesis missing / a bogus `NEMESIS_BIN` that runs but emits no verdict / timeout / unparseable / non-existent stage ⇒ `error` ⇒ BLOCK.

The gate runs the same binary + flags as the engine via `nemesis_gate` (`$NEMESIS_BIN` →
sibling PROMETHEUS root → `which('nemesis')`; `--sandbox auto --jail auto --sign
--timeout 840`). We store the signed **verdict ref** bound to the commit, never a
recomputed verdict — re-asking the engine is cheap and authoritative (C5).

> **Env limit:** a REAL `git clone` of a *remote* URL needs network (unavailable in the
> sandbox). The clone path is correct and is proven offline with a tiny local `file://`
> repo; the security-load-bearing GATE DECISION is tested deterministically with planted
> local staging dirs (malicious ⇒ block + quarantine, clean ⇒ promote + index + ref).

---

## refactor.py — AST analysis + rope-backed WorkspaceEdit engine (APP-025)

Read-only verbs (pure stdlib `ast`, always available):

| verb | args | success output shape (one object) |
|---|---|---|
| `structure` | `--file F` | `{ok, command:"structure", file, structure:[{kind:function\|class, name, line, args?\|bases?+members?}]}` |
| `imports` | `--file F` | `{ok, command:"imports", file, imports:[{module, name?, as, line}]}` |
| `callgraph` | `--file F` | `{ok, command:"callgraph", file, edges:[{from, to}]}` |
| `version` | — | `{ok, command:"version", version}` |

Generator verbs (APP-028) — pure stdlib `ast`, always available, proposal-only.
Each locates the innermost class (function for `gen-docstring`) containing 1-based
`--line`, derives fields/signatures from the REAL AST (never regex on source), and
emits a WorkspaceEdit whose positions always sit at `{line, character: 0}` (whole-line
inserts — EOL-style/UTF-16 safe). Indentation is read from the class's own body
(tabs-vs-spaces preserved). Common failure codes: `member-exists` (member already
defined), `no-fields` (no derivable instance fields — dynamic attrs; the UI offers the
local-AI generator), `unsupported`, `not-found`:

| verb | args | success output shape (one object) |
|---|---|---|
| `gen-init` | `--file F --line L [--attrs a,b]` | `{ok, command, edit, files, target, member:"__init__"}` — params from class-level `AnnAssign`/`Assign` fields (`ClassVar[...]` skipped, defaulted params reordered last) |
| `gen-repr` | `--file F --line L [--attrs a,b]` | `{…, member:"__repr__"}` — f-string over `__init__` self-assignments first, then class fields |
| `gen-eq` | `--file F --line L [--attrs a,b]` | `{…, member:"__eq__"}` — isinstance guard + field-tuple compare (1-tuples keep the trailing comma) |
| `gen-dataclass` | `--file F --line L` | `{…, target, fields:[...]}` — inserts `@dataclass` (+ the import if missing, honoring an existing `import dataclasses`), field annotations, and DELETES the assignment-only `__init__` as a range edit; `code:"unsupported"` when `__init__` has logic beyond `self.x = x` |
| `gen-property` | `--file F --line L --attr NAME` | `{…, member}` — `@property` + setter over the `_NAME` backing field (annotation propagated when the field is annotated) |
| `gen-override` | `--file F --line L --method NAME` | `{…, member}` — full signature copied from the in-module base (posonly `/`, defaults, `*`, kw-only, `**`), body forwards to `super()`; `code:"not-found"` when the base method isn't in this module |
| `gen-delegate` | `--file F --line L --attr FIELD --method NAME` | `{…, member}` — signature resolved from the field's in-module class (async targets are awaited), else a `*args, **kwargs` pass-through |
| `gen-docstring` | `--file F --line L` | `{…, member:"__doc__"}` — Google-style stub listing exactly the signature's params (tail-aligned defaults noted) + `Returns` from the annotation. **Idempotent:** an existing docstring (per `ast.get_docstring`) returns `{ok:true, noop:true, edit:{"changes":{}}, files:[], reason}` |

Mutating (proposal-only) verbs — require the OPTIONAL `rope` package (the only pip dep
this sidecar may use, imported at call time; metadata.py's optional-tool pattern):

| verb | args | success output shape (one object) |
|---|---|---|
| `extract` | `--file F --start-line N --end-line M --name X [--kind method\|variable] [--start-col A --end-col B] [--root D]` | `{ok, command:"extract", edit:<WorkspaceEdit>, files:[uri...], name, kind}` (cols are 1-based inclusive; `--kind variable` needs an expression span) |
| `inline` | `--file F --line L --col C [--root D]` | `{ok, command:"inline", edit, files}` |
| `move` | `--file F --symbol S --dest MODULE.py [--root D]` | `{ok, command:"move", edit, files, symbol, dest}` — dest module MUST exist (the sidecar never creates files); multi-file edits list every touched uri |
| `change-signature` | `--file F --line L --col C --order i,j,k [--remove n] [--root D]` | `{ok, command:"change-signature", edit, files, order, removed}` — `--remove` and `--order` both speak ORIGINAL 0-based param indices; `--order` must be a permutation of the remaining (post-removal) original indices |
| `safe-delete` | `--file F --line L --col C [--root D]` | zero live usages: `{ok, command:"safe-delete", edit, files, symbol}` · live usages remain: `{ok:false, code:"usages-remain", symbol, usages:[{uri, line}], error, _exit:2}` and NO edit (`--line/--col` must point at the def/class NAME; `usages[].line` is **1-based**, like every other sidecar line field — only WorkspaceEdit positions are 0-based). When deleting a block's only statement would break syntax (e.g. a class's sole method), the edit substitutes an indented `pass` instead of empty text |
| `rename` | `--file F --line L --col C --new-name X [--root D]` | `{ok, command:"rename", edit, files, new_name}` — byte-parity with the LSP rename path through the Studio applier (test-asserted) |

Common argv semantics: `--line`/`--col` are **1-based** editor coordinates over rope's
`\n`-normalized text (CRLF files are normalized before offsets are computed — offsets
never desync). Columns count **UTF-16 code units** (Monaco/LSP editor columns), the same
basis as the emitted `character` fields. `--root D` sets the rope project root (default:
the file's directory); `--file`/`--dest` must resolve inside it (containment is checked
on symlink-resolved paths). Renaming across files requires `--root` to span the importers.

### The WorkspaceEdit envelope (LSP-shaped, applier-compatible)

`edit` is exactly what the Studio applier (`text-edit-apply.ts` `normalizeWorkspaceEdit`)
consumes — the SAME shape the LSP rename path returns:

```json
{"changes": {"file:///abs/path.py": [
  {"range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 8}},
   "newText": "compute"}]}}
```

* URIs: `file://` + absolute path, unencoded — Studio's canonical form. Paths under the
  caller's `--root` keep the RAW (unresolved) root prefix so they match open Monaco model
  URIs even when the workspace path traverses a symlink.
* Positions: **0-based** `line`/`character`; `character` counts UTF-16 code units
  (JS string indexing), so astral chars count as 2.
* Edits are minimal line-block diffs (single-line token changes are char-trimmed);
  non-overlapping, applier splices last-first.
* `files` mirrors `sorted(edit.changes)` for cheap consumption.
* A refactoring that produces no textual change fails with `code:"empty-edit"`.
* File create/move/delete resource ops are NEVER emitted (the TS normalizer drops
  them silently); a refactor requiring one fails instead.

### The read-only guarantee (sidecar proposes, Studio applies)

The sidecar **never writes any project file**: rope's `ChangeSet` is inspected
(`ChangeContents.new_contents`), `project.do()` is never called, and the rope project
is opened with `ropefolder=None` so no `.ropeproject` folder is ever created. Tests
pin content+mtime of every fixture file after every verb. Applying the edit (with
preview/undo) is exclusively the Studio applier's job.

### The `rope-missing` degradation

Without `rope` installed every mutating verb fails closed —
`{ok:false, command, code:"rope-missing", error:"structural refactoring needs the optional 'rope' package (pip install rope)", _exit:2}`
— never a stub edit, never a crash. The read-only AST verbs keep working. `rope` must
never become a hard requirement of sidecar boot.

---

## Examples

```
$ python3 envmgr.py cuda.info
{"available":false,"command":"cuda.info","cuda_version":null,"driver":null,"gpu":null,"nvcc":false,"nvidia_smi":false,"ok":true,"torch_cuda":null}

$ python3 modelhub.py fit.score --params 7b --quant q4_k_m
{"command":"fit.score","headroom_ratio":0.09,"hw_basis":"scanned","needed_bytes":...,"ok":true,"recommended_quant":"q8_0","usable_gb":44.8,"verdict":"fits",...}

$ python3 envmgr.py pkg.install myenv numpy           # no --confirm → gated PLAN
{"command":"pkg.install","ok":true,"planned":true,"plan":{"download":[...],"gate":[...],"install":[...]},"request":{"env":"myenv","specs":["numpy"],...},"force":false,"note":"re-run with --confirm to stage, scan (nemesis), and gated-install"}

$ python3 envmgr.py pkg.install myenv evil-pkg --confirm    # nemesis BLOCK → fail-closed
{"command":"pkg.install","ok":false,"blocked":true,"request":{...},"gate":{"verdict":"block","score":100,"reasons":["DROP-001 @ .../setup.py",...],"signed":true},"message":"refused — nemesis BLOCK; not installed. Re-run with force:true (typed confirm) to override.","_exit":2}

$ python3 repo.py clone --url https://github.com/acme/lib.git --staged /tmp/staged   # clean tree → promoted
{"command":"clone","ok":true,"promoted":true,"verdict":"allow","id":"acme__lib","local_path":".../repos/acme__lib","gate":{"verdict":"allow","score":0,"signed":true,...},"verdict_ref":{"verdict":"allow","commit":"...","signedAt":"...","findingsRef":"..."},"entry":{"id":"acme__lib","status":"cloned",...},"message":"promoted acme__lib → ..."}

$ python3 repo.py clone --url https://example.com/sketchy/repo --staged /tmp/evil   # nemesis BLOCK → quarantined
{"command":"clone","ok":false,"promoted":false,"blocked":true,"status":"blocked","verdict":"block","gate":{"verdict":"block","score":100,...},"quarantined":".../repos/.stage/.quarantine/sketchy__repo.169...","message":"refused — nemesis BLOCK; staged clone quarantined for inspection (NOT deleted). Re-run with force:true (typed confirm) to override.","_exit":2}
```

## sqlrunner.py — the SQL console backend (file 14 §3.26, APP-041)

Stateless per-invocation DB access. sqlite via stdlib `sqlite3`; postgres/mysql via
OPTIONAL lazily-imported env drivers (`psycopg2`/`psycopg`, `pymysql`) — a missing
driver is a fail-closed envelope `{ok:false, error, driver_missing:"<pip-pkg>", _exit:2}`,
never a traceback. The connection string carries credentials in argv and is NEVER
echoed back: the password (`:pass@`) is redacted from every envelope AND from any
caught driver-exception text. Guards: default `--max-rows 1000` (hard ceiling 50_000,
`fetchmany`-chunked), `--timeout-s` (driver-native statement timeout + a sqlite
progress-handler wall-clock fallback) → `{ok:false, error:"timeout", truncated:true}`.

| verb | args | success output shape (one object) |
| --- | --- | --- |
| `sql.connect` | `<conn> [--timeout-s N]` | `{ok, command:"sql.connect", dialect, database, server_version}` |
| `sql.query` | `<conn> --sql T [--params <json-array>] [--max-rows N] [--timeout-s N]` | `{ok, command:"sql.query", columns:[…], rows:[[…]], row_count, truncated, duration_ms}` |
| `sql.schema` | `<conn> [--table T]` | `{ok, command:"sql.schema", tables:[{name, type:"table"|"view", columns:[{name, dtype, nullable, pk}]}], count}` |

Placeholders are driver-native and NEVER string-interpolated: `?` (sqlite), `%s`
(pg/mysql); `--params` is a JSON array passed as the second arg to `cursor.execute`.
Rows are JSON-safe: bytes→base64, datetime→isoformat, Decimal→str, NaN/Inf→null.

## kernel.py — live Jupyter kernel (file 14 / APP-044)

`kernel.py` is the ONE sidecar with TWO modes. `jupyter_client`/`ipykernel` are the
user's **runtime** env deps (NOT vendored / new pip installs) — imported LAZILY inside
`serve`; absent → a single fail-closed error naming `pip install jupyter_client ipykernel`
+ exit 2. `probe`/`guard` are **stdlib-only** (run on a bare box).

### One-shot mode (classic C7 single-envelope) — `probe`, `guard`, `version`

| verb | args | success output shape (one object) |
| --- | --- | --- |
| `kernel.probe` (alias `probe`) | — | `{ok, command:"kernel.probe", ready, jupyter_client, ipykernel, kernelspecs:[…], python_version, hint}` |
| `kernel.guard` (alias `guard`) | — | `{ok, command:"kernel.guard", allow, threshold_pct, cpu_pct, ram_pct, tripped:[…], reason?}` |
| `version` | — | `{ok, command:"version", version}` |

`ready` = both deps importable AND a kernelspec present. `hint` is the pip line when not
ready, else `null`. `probe` imports NOTHING from `jupyter_client` at module top.

### Serve mode (LONG-LIVED — deliberately NOT one-object) — `serve [--kernel python3] [--wall-cap-s 300]`

> **⚠️ Contract deviation (on purpose).** `serve` speaks an **NDJSON event stream**: it
> reads ONE JSON *request* per **stdin** line and writes ONE JSON *event* per **stdout**
> line — many objects over the process lifetime, NOT the single-object C7 rule. The bridge
> MUST consume it with `spawnKernelSidecar` (a line reader); `parseSidecarObject`'s
> last-object scanner would misparse it. Every stdout line is flushed immediately so
> outputs stream incrementally.

**Requests (stdin, one JSON object per line):**

| request | effect |
| --- | --- |
| `{op:"execute", id, code}` | run a cell; its outputs are relayed carrying the same `id` |
| `{op:"interrupt"}` | SIGINT the *running* cell (kernel process); the supervisor stays alive |
| `{op:"restart"}` | fresh kernel, state cleared, `execution_count`→1, re-emits `ready` |
| `{op:"vars"}` | list user-namespace variables |
| `{op:"inspect", name}` | detail for one variable |
| `{op:"shutdown"}` | clean kernel shutdown then exit (also on stdin EOF / SIGTERM) |

**Events (stdout, one JSON object per line — `{event, id?, …}`):**

| event | payload |
| --- | --- |
| `ready` | `{kernel, execution_count}` — kernel is up (emitted on start + after restart) |
| `stream` | `{id, name:"stdout"\|"stderr", text}` — incremental output chunk |
| `execute_result` / `display_data` | `{id, data:{<mime>:…}, execution_count?}` — `image/*` is base64 (size-capped); `text/plain` is the repr |
| `error` | cell error `{id, ename, evalue, traceback:[…], fatal:false}` **or** a launch failure `{id:null, fatal:true, error, hint?, guard?}` |
| `vars` | `{variables:[{name, type, repr}]}` — repr ≤200 chars, dunders/`_`-prefixed excluded |
| `inspect` | `{name, found, type, repr, doc}` — repr ≤2000 chars |
| `done` | terminal per-cell `{id, status:"ok"\|"error"\|"aborted", execution_count, ename?, evalue?, traceback?, aborted_by?, truncated}` |

The authoritative "cell done" is the iopub `status`==`idle` whose `parent_header.msg_id`
matches the execute request (events are mapped to cells by `parent_header.msg_id`, never
by arrival order).

**Guards (fail-closed, never weakened):**
- **Launch guard** — refused when CPU% or RAM% ≥ 90 (mirrors `telemetry-guard.ts`
  `GUARD_THRESHOLD_PCT`); a `fatal:true` error event + exit 2. (A host that can't be
  measured does NOT trip.) Override hooks: `PROMETHEUS_KERNEL_FORCE_PRESSURE`,
  `PROMETHEUS_KERNEL_SKIP_GUARD`, `PROMETHEUS_KERNEL_GUARD_PCT`.
- **Wall-clock cap** — default 300s (`--wall-cap-s` / `PROMETHEUS_KERNEL_WALL_CAP_S`);
  on expiry the cell is auto-interrupted → `done{status:"aborted"}` (a tight C loop that
  ignores SIGINT is hard-stopped; the caller may then `restart`).
- **Output caps** — per-message 1 MiB, per-cell cumulative 16 MiB (a marked `stream`
  notice, then `done{…, truncated:true}`); an image mime payload passes through to 8 MiB.

**No orphans:** SIGTERM + `atexit` shut the kernel down, and stdin EOF is treated as
shutdown, so no ipykernel child survives the Electron app.

## repomap.py — tree-sitter/stdlib repo-map for @codebase (MDS parity 39, APP-053)

Parses a whole repo into a RANKED symbol map for agent `@codebase` grounding. tree-sitter
is used ONLY if importable; the stdlib path (`ast` for python + regex signatures otherwise)
is the complete fallback — NO new pip deps. Never crashes on a binary/unparseable file
(NUL-byte sniff skips binaries; `ast.parse` SyntaxError → regex fallback). Ignored dirs
(.git/node_modules/dist/out/build/__pycache__/venv/target/…) are pruned during the walk;
file enumeration prefers `git ls-files -co --exclude-standard`, else `os.walk` with in-place
pruning. Ranking = personalized PageRank over the symbol reference graph (a symbol referenced
by many/important symbols floats up); `--query` seeds the personalization vector. Output is
budget-trimmed (~4 chars/token, default 8000) keeping the highest-rank symbols globally.

| verb | args | success output shape (one object) |
| --- | --- | --- |
| `map` | `<root> [--budget N] [--query Q] [--max-files N]` | `{ok, command:"map", files:[{path, symbols:[{name, kind, line, rank}]}], generatedAt, parser, symbolCount, truncated}` |
| `refresh` | `<root> --files a,b [--budget N] [--query Q]` | same shape but `files` contains ONLY the named files (ranks are still global — the whole graph is re-ranked) |

`kind` ∈ class/method/function/interface/enum/type; `line` is 1-based; `rank` ∈ [0,1]
(normalized). `parser` = "tree-sitter" when the binding is importable, else "ast+regex".
