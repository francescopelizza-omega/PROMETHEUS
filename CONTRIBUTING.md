# Contributing to PROMETHEUS

Thanks for considering a contribution. This project spans three components — the Python
engine (`prometheus.py` + `nemesis`), the Studio monorepo (`studio/`, pnpm + Turbo), and the
cross-agent MCP adapter layer (`prometheus_plugin/`) — pick whichever one your change touches;
you don't need to understand all three to contribute to one.

## Before you start

- **Turn the git hooks on, once per clone:**

  ```sh
  git config core.hooksPath .githooks
  ```

  They are not optional and they are not style checks. `pre-commit` refuses a `process.kill`
  that could broadcast a signal (a unit test once SIGKILLed a whole logged-in session — see
  CLAUDE.md §2). `pre-push` runs the two disclosure scanners before the one act that cannot be
  undone: `scripts/secret-scan.sh` for credentials across the whole history, and
  `scripts/check-personal-data.sh` for the other half — home paths, hostname, personal email —
  which no secret scanner flags. Both also run in CI's `security` stage, so a clone without the
  hooks is caught later rather than never; the hooks just tell you before you have published.

  A finding that is genuinely a test fixture is allowlisted in `.gitleaks.toml` **by value,
  never by path** — that file explains why an allowlisted path is a blind spot.

- **Security issues do not go through a PR or a public issue.** See [SECURITY.md](./SECURITY.md).
- For anything non-trivial (a new feature, a behavior change, a new tool the agent can call),
  open an issue first describing what you want to do and why. Small, well-scoped fixes
  (typos, a clear bug with an obvious fix, a missing test) can go straight to a PR.
- This is a security-first project. A PR that adds a new way to write files, run commands,
  reach the network, or otherwise expand what an AI agent can do on the user's machine will
  be held to a higher bar than an ordinary bug fix — expect questions about the safety
  invariants (the authorization ladder, the nemesis gate, confirm-before-mutate) and be ready
  to show your change doesn't weaken them.

## Building and testing

The Studio monorepo (`studio/`) is pnpm + Turbo, Node ≥22.6:

```bash
cd studio
pnpm install
pnpm run typecheck   # tsc -b across every package + the desktop app + the VS Code extension
pnpm run lint         # biome + the project's own token/layout guard scripts
pnpm run test         # the full node:test suite (NOT `turbo run test` — see .gitlab-ci.yml's
                       # own comment on why: turbo would silently skip most of the suite)
```

The Python engine has no dependencies to install — `python3 prometheus.py --help` should just
work on Python 3.9+. `nemesis` is the same: stdlib-only, run it directly.

`.gitlab-ci.yml` at the repo root is what actually gates merges — if your change passes that
pipeline locally (`typecheck` + `lint` + `test` + an electron-vite build), it will almost
certainly pass in CI too.

## What "done" means here

This project has a documented history of features that passed their own unit tests against
fakes but broke — or were never wired at all — against a real model, a real running app, or a
real command. If your change is more than a pure refactor, verify it against something real
before calling it done, and say in the PR description what you actually verified versus what
you're trusting the test suite for. "The tests pass" and "I ran it and watched it work" are
different claims — be clear about which one you're making.

## Code style

- No comments explaining *what* code does — names should do that. A comment earns its place
  only when it captures a non-obvious *why*: a hidden constraint, a workaround, an invariant
  that would surprise a reader.
- Don't add abstractions, error handling, or configurability for cases that can't happen or
  haven't been asked for. Three similar lines beat a premature abstraction.
- `biome check` (via `pnpm run lint`) is the formatting authority — don't hand-format against it.

## Commit / PR conventions

- Keep commits focused; a PR that does one thing is easier to review than one that does five.
- Describe *why* in the PR body, not just *what* — the diff already shows what changed.
- Don't force-push over review feedback on an open PR unless a maintainer asks for it.

## License

By contributing, you agree your contribution is licensed under **Apache-2.0**, which governs
every part of this repository — the engine, `nemesis`, Studio, the CLI, the VS Code extension
and `prometheus_plugin`. Apache-2.0 §5 makes that the default for anything you submit here.

That also means your contribution carries a patent grant (§3) and that you keep the copyright
in what you wrote; you are licensing it, not assigning it. See [NOTICE](./NOTICE) for the
attribution obligations that travel with any fork or derivative work.
