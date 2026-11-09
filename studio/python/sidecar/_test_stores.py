"""_test_stores.py — sidecar tests never touch a real model store (imported by conftest.py
and at the top of every test module that admits a model, so `python -m unittest` is covered).

Model weights are placed into the serving software's OWN folder (the Hugging Face cache, LM
Studio's models folder, llama.cpp's cache — `model_place.py`). A test that admits a fake GGUF
would otherwise write it into the developer's real `~/.cache/huggingface/hub`. Every store is
pointed at a throwaway directory for the whole run, before any test module is imported, and
child processes inherit it (the harnesses build their env from `os.environ`).
"""
from __future__ import annotations

import atexit
import os
import shutil
import tempfile

_ROOT = tempfile.mkdtemp(prefix="sidecar-test-stores-")
atexit.register(shutil.rmtree, _ROOT, True)
# FORCED, not setdefault: a developer's exported PROMETHEUS_MODELS_HOME used to send the tests
# into the real gate library and placement ledger. Tests that need their own still set it.
for _var, _sub in (("HF_HUB_CACHE", "hf-hub"), ("LMSTUDIO_MODELS_DIR", "lmstudio-models"),
                   ("LLAMA_CACHE", "llama-cache"), ("PROMETHEUS_MODELS_HOME", "gate"),
                   ("PROMETHEUS_MODELS_DIR", "download-cache"), ("PROMETHEUS_TOOLS_DIR", "tools"),
                   ("MODELHUB_OLLAMA_MODELS", "ollama-store")):
    os.environ[_var] = os.path.join(_ROOT, _sub)
    os.makedirs(os.environ[_var], exist_ok=True)
# Never reach the real Ollama: no `ollama serve` is ever spawned (an orphaned, uncapped daemon
# is the CLAUDE.md §2.8 trap), and the zero-copy import never writes into a live daemon's store.
os.environ["MODELHUB_NO_DAEMON_SPAWN"] = "1"
os.environ["MODELHUB_TEST_STORES"] = _ROOT
# the seams (MODELHUB_FAKE_* …) are honoured only with this marker — see _envelope._strip_seams
import secrets  # noqa: E402

_TOKEN = secrets.token_hex(16)
with open(os.path.join(_ROOT, ".modelhub-test-marker"), "w", encoding="utf-8") as _f:
    _f.write(_TOKEN)
os.environ["MODELHUB_TEST_TOKEN"] = _TOKEN
