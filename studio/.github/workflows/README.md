# These workflows do not run. They never have.

Four GitHub Actions workflows live in this directory — `ci.yml`, `build.yml`, `nightly.yml`,
`release.yml`. None of them has ever executed, and nothing about the repository makes that
visible: the files are well-formed, the YAML is valid, and a reader reasonably assumes the
project has CI.

Three separate reasons, any one of which is sufficient:

1. **Wrong location.** GitHub Actions reads `.github/workflows/` at the **repository root**.
   The git root here is the `PROMETHEUS/` directory one level up, so these sit at
   `PROMETHEUS/studio/.github/workflows/` — a path Actions never looks at.

2. **Wrong layout.** Every one of them declares `working-directory: PROMETHEUS/studio` and
   `PROMETHEUS_PY: ${{ github.workspace }}/PROMETHEUS/prometheus.py`. They were authored when
   this project was a subdirectory of a larger `ALPHA` repository. That repository now
   gitignores `/PROMETHEUS/` entirely.

3. **Wrong forge.** The remote is GitLab (`gitlab.com/red-beard-phoenix/PROMETHEUS`). GitHub
   Actions would not run for it even from the correct path.

## They would also not have verified much

`ci.yml` and `build.yml` verify with `pnpm turbo run lint typecheck test build`. Turbo runs the
**per-package** task, and `turbo.json` declares no root (`//#`) tasks — so the root `package.json`
scripts never executed, which meant the two custom guard scripts (`check-no-raw-hex`,
`check-layout-rules`) were skipped entirely.

Worse, at the time these were written `apps/desktop` declared **no `test` script at all** and
`apps/cli`'s named a **single file**. `turbo run test` therefore ran roughly a third of the
suite — around 150 of some 400 files — and reported green. (Both scripts have since been fixed
to run their whole package, so `turbo run test` is now honest.)

## What actually runs the checks

`/.gitlab-ci.yml` at the repository root. It calls `node scripts/run-tests.mjs` directly rather
than through turbo, for exactly the reason above, and it pins Node 22 — `apps/cli/dev-resolver.mjs`
resolves sources with `format: "module-typescript"`, which does not exist before Node 22.6, so a
runner honouring the old `.nvmrc` of `20` would have failed every suite before running a test.

## If you move to GitHub

These files are kept rather than deleted because they encode real work — the matrix, the
notarisation lane, the osv-scanner pass. To revive them:

- move this directory to the **repository root** (`PROMETHEUS/.github/workflows/`);
- drop the `PROMETHEUS/` prefix from every `working-directory` and path;
- replace `turbo run test` with `node scripts/run-tests.mjs`;
- set `node-version: 22` (not the `.nvmrc` value, unless that is also 22);
- check `apps/desktop/electron-builder.yml` — its `publish:` block pointed at
  `owner: dev, repo: prometheus`, a namespace this project does not own, and has
  been removed. `release.yml` and `build.yml` still assume it.
