# Changesets

This folder holds [Changesets](https://github.com/changesets/changesets) for the
publishable packages of Prometheus Studio (file 02 §1.4).

- Add a changeset with `pnpm changeset` (describes a version bump + changelog entry).
- Apply pending changesets with `pnpm version` (`changeset version && pnpm install --lockfile-only`).
- The monorepo as a whole is **private/unpublished**; `@prometheus/desktop` is
  version-managed by electron-builder + the auto-updater and is `ignore`d here.
  `@prometheus/cli` (`prometheus`) is the unit that ships via npx / brew (see file 11).
