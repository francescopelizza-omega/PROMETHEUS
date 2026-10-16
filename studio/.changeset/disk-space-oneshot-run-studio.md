---
"@prometheus/cli": minor
"@prometheus/core": minor
"@prometheus/engine-bridge": minor
---

`prometheus run`, full-screen `prometheus disk-space`, Studio "Open as administrator", and a
packaged Studio that ships its Python.

- **`prometheus run <prompt…>`**: one headless turn with a model, the answer on stdout, then exit
  (the same turn as `-p`; `cat task.md | prometheus run` reads the prompt from stdin).
- **`prometheus disk-space [PATH]`** on a terminal runs disk_space.py's own TUI full-screen; Ctrl+D
  ends it and Prometheus exits. `sudo prometheus disk-space` runs it as root — the human typed sudo.
  As root the launcher never rebuilds the checkout and the one-shot keeps its state in root's home.
- **Studio: Open as administrator…** in the Disk space panel. The privileged gate shows the exact
  command; on approval sudo's native password dialog asks (every time); the explorer then runs as
  root in its own window, whose keys main reads from the keyboard (`before-input-event`) — no
  renderer can type into root (new gate terminal mode over `pty_host.py`, askpass-only). Ctrl+D,
  Stop or closing the window ends it.
- **Root runs exactly the approved script bytes** (`privileged-verify.ts`): Python through a fixed
  loader that re-hashes as root and runs the bytes it hashed, shell scripts from their approved
  bytes passed inline, root-owned scripts as they are; perl/ruby/node scripts outside root's
  control are refused. Closes the window between the gate's last check and root opening the file.
- **Packaged Studio ships its Python**: `stage-engine.mjs` stages every sidecar, `disk_space.py`
  and `pty_host.py`; main points the engine, the sidecars and the interpreter at Resources
  (`PROMETHEUS_PYTHON` now ranks first everywhere). Every sidecar-backed panel used to fail in the
  DMG with "sidecar not found".
- The approval dialog no longer scrolls the command out of view when a script preview is long, and
  xterm's stylesheet is loaded (its input helper was drawn as a grey box).
