---
"@prometheus/cli": minor
"@prometheus/core": minor
---

`/models` is now a guided model picker in the CLI, the TUI and the desktop Models page: local
(always free, fit-checked against this machine's RAM) or cloud → free cloud models (NVIDIA NIM,
Groq, Cerebras, Gemini, Mistral, OpenRouter, SambaNova, Z.ai, Ollama Cloud, Hugging Face, keyless
OVHcloud), paid cloud models (Claude 5, GPT-5 / Codex, Gemini Pro, DeepSeek, Mistral, Kimi), or
the **endless free spinner** — one endpoint that rotates across every free LLM API you can reach,
failing over on quota limits before the first token. Each model shows two lines (strengths,
limits); a pick installs Ollama, downloads weights or stores a verified key (hidden input, OS
keychain) for you, and names colibri/AirLLM up front when a model only runs that way. The old
`/models <action>` engine verbs still work (`/models tools` is the old listing). The last pick is
remembered across sessions and surfaces.
