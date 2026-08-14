# python/sidecar

The thin contract layer between `@prometheus/engine-bridge` (Node) and the Python engine
(`../../../prometheus.py` + `../../../nemesis`).

It does **not** reimplement engine logic. It standardizes how the bridge launches the engine,
reusing the existing contract:

- run `python3 prometheus.py --json <cmd>` → exactly one JSON object on stdout, human logs on stderr;
- run `nemesis ...` for security verdicts;
- for long ops, stream JSON-lines / progress on stderr.

At package time this is bundled (embedded interpreter / PyInstaller) so end users need no system Python.

Monorepo/tech-stack and build/dist/test rationale live in the maintainer's internal spec set
(not part of this repo).
