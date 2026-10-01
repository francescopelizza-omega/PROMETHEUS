# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Francesco Pelizza
"""Test isolation for the engine's own config dir.

`prometheus.py` resolves `PROM_DIR` (and the skills dir, trust file and URL-pin manifest
derived from it) at IMPORT time, so the redirect has to be in place before any test module
does `import prometheus`. pytest loads this file first, which is the only hook early enough.

Without it the suite wrote into the real `~/.config/prometheus`: the crash-guard test
(`TestCrashGuard`) deliberately raises inside a dispatched handler, and the guard dutifully
overwrote the user's genuine `last-crash.log` — the one file it had just told them to report.
"""

import os
import tempfile

_SANDBOX = tempfile.mkdtemp(prefix="prometheus-tests-cfg-")
os.environ["PROMETHEUS_CONFIG_DIR"] = _SANDBOX
