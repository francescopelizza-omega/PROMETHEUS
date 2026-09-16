# Prometheus Studio — Privacy

> This file is the **source of truth** for the app's data flow, audited each release
> (file 10 §8). It ships in-app under **Help → Privacy**. Prometheus Studio is a
> security IDE; its privacy posture is a feature, not an afterthought.

## The five principles

1. **Off by default.** No analytics, no crash upload — nothing leaves your machine —
   until you opt in on first run. The first-run screen has two clear options and the
   default is *stay local*. No dark patterns.
2. **Local-first audit, not remote telemetry.** Everything interesting is logged
   **locally, on disk, in plain JSONL you can read**:
   - `~/.nemesis/gate-audit.jsonl` — the engine's append-only, signed gate-decision log
     (installs, verdicts; written by the engine, reused by Studio).
   - `~/.prometheus/config/events.jsonl` — UI-side actions (panels opened, downloads
     started). **Never auto-sent.** Settings → Privacy → *Open my data folder* /
     *Export* / *Wipe*. NOTE: no shipping surface writes this file yet — the recorder
     exists but nothing is wired to it, so today this path is where UI events *will*
     be written, not a file you will find. The gate-audit log above is real and live.
3. **Crash reporting is opt-in and scrubbed.** If you enable it, reports are scrubbed
   before leaving: `$HOME` paths → `~`, URLs → `[url]`, and any field whose name looks
   secret (repo/url/path/model/token/secret/key/email/…) → `[redacted]`. PII budget = 0.
4. **No network call without a visible reason.** The app contacts the network only for:
   update checks (the channel you chose), model/repo downloads (you initiate them), and
   `nemesis update` feed pulls (shown in the Security panel). Settings → Network lists
   every domain the app may contact and lets you block categories. Offline mode keeps
   every **local** engine operation working (scanning never needs the network).
5. **Update pings carry only `{ studioVersion, channel, os, arch }`** — no install id,
   no fingerprint. GitHub Releases sees your IP from the download; we add nothing.

## What is stored, where, and who can read it

| Data | Location | Sent anywhere? |
|---|---|---|
| Gate decisions / verdicts | `~/.nemesis/gate-audit.jsonl` (signed) | No (local) |
| UI events | `~/.prometheus/config/events.jsonl` (not yet written by any surface) | No unless you opt in (then scrubbed) |
| Secrets (API keys, tokens) | OS keychain (`com.prometheus.studio`) | No — never written to a settings file |
| Settings / profiles | `~/.prometheus-studio/settings.json`, `.prometheus/settings.json` | No |
| Crash reports (opt-in) | your chosen vendor | Only if enabled; scrubbed first |

## Auto-update

Studio **never auto-installs** an update. It downloads only after you consent and
installs only when you click *Install & relaunch* (file 10 §5). Signatures are verified
natively (macOS code signature, Windows publisher) and via GPG on Linux before any
update is applied.

## Engine vs Studio

The engine (`prometheus.py` / `nemesis`) is stdlib-only and runs locally. It is shipped
*inside* each Studio release; `nemesis update` refreshes threat signatures over the
network (visible in the Security panel) — that is the only engine network activity, and
scanning itself never touches the network.
