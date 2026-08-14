# Prometheus Studio — Design (visual spec of record)

These files are the **visual spec of record** for Prometheus Studio, kept in sync with the
maintainer's internal design-system doc (not part of this repo). If a value or screen here
drifts from that doc, the doc wins — update these to match.

## Index

- [`tokens.md`](./tokens.md) — human-readable design-token reference (colors, typography, spacing,
  radius, elevation, density, motion, the 20 built-in schemes, and how tokens are consumed).
  Derived from the actual values in `packages/ui/src/tokens.ts` and
  `packages/ui/src/tokens/tokens.json` — do not invent values; regenerate from those sources.
- [`wireframes/`](./wireframes/) — one normative ASCII screen per key surface, copied verbatim from
  §5 of 08, each with binding/data-source notes:
  - [`home.txt`](./wireframes/home.txt) — Home / Mission Control (⌂, §5.1)
  - [`security-verdict.txt`](./wireframes/security-verdict.txt) — Security verdict modal (🛡, §5.2)
  - [`venv.txt`](./wireframes/venv.txt) — Venv / Environment manager (⬢, §5.3)
  - [`model-hub.txt`](./wireframes/model-hub.txt) — Model Hub (◴, §5.4)
  - [`catalog.txt`](./wireframes/catalog.txt) — Catalog browser (⬚, §5.5)
  - [`editor.txt`](./wireframes/editor.txt) — Editor / IDE core (⌨, §5.6)
  - [`terminal.txt`](./wireframes/terminal.txt) — CLI / integrated terminal (❯, §5.7)

The ASCII is normative for **layout intent**, not pixel spec; every data field maps to a real engine
JSON key (noted under each screen).
