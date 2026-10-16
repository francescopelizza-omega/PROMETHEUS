# Threat model — what nemesis actually protects you from

> This is the honest stance shown verbatim in the in-app **security / about** pane
> (the `ThreatModel` view). It carries the engine's own framing into Studio so we
> never oversell. Every claim here is grounded against the real `nemesis 1.12.0`
> verdict (`schema: "nemesis.verdict/1"`) that Studio renders — never against a
> heuristic the GUI invented.

## Defense in depth, not a guarantee

**nemesis is heuristic static analysis + signatures + SCA, not a sandbox.** It
reads code and metadata; it does **not** run the artifact in isolation and watch
what it does. A clean verdict means *"no known-bad patterns were found in the
scanned code"* — it does **not** mean *"this code is safe to run."*

Because of that, Studio's green state reads:

> **SAFE — no known threats found**

never the bare word **"Safe"**. The difference is the whole point: we are
reporting the absence of *known* threats, not asserting safety. This is
**defense in depth, not a guarantee.**

## The layers (and what each one can and cannot see)

nemesis stacks several independent detectors. Each catches a different class of
threat, and each has blind spots the others partly cover:

- **Regex + heuristic source rules** — reverse shells (`RSHELL-*`), fetch-to-exec
  staged payloads (`RT-FETCHEXEC`), install-time shell (`PKG-*`), auto-run-on-open
  (`AUTORUN-*`), Trojan-Source bidi / zero-width (`HEUR-BIDI/INVIS`), git
  weaponization (`GIT-*`), GitHub Actions pwn-request (`GHA-*`), hardcoded secrets
  (`SECRET-*`). Static text matching: it sees patterns, not intent, and an
  obfuscated payload can evade a pattern.
- **AST / SAST** (`SAST-*`, depths off / lite / full) — `eval`/`exec` of a
  non-literal, `subprocess(shell=True)` on a variable, etc. Sees structure, not
  runtime values.
- **Signatures** — ClamAV `.ndb` body sigs + a hash/IOC blocklist (SHA256/SHA1/MD5,
  domains, URLs, IPs). Catches *known* malware only. A brand-new sample with no
  signature is invisible to this layer.
- **SCA** — OSV advisories across PyPI / npm / crates.io / RubyGems / Packagist /
  Go, with CISA KEV escalation. Catches *published* CVEs in *parseable* lockfiles.
  An ecosystem with no index is reported in `provenance.sca_unscanned_ecosystems`
  — honestly, not silently.

None of these execute the artifact. A determined, novel, well-obfuscated attacker
can defeat any single layer; the stack raises the cost, it does not close the door.

## Fail-closed everywhere

The GOLDEN RULE is enforced in code, not just stated here: **JavaScript never
decides "safe" — it renders a verdict the Python engine computed.** There is no
severity scoring, no allowlist, no regex rule, no "looks fine" heuristic anywhere
in the TypeScript codebase. The only spawner of `python3` / `nemesis` is
`@prometheus/engine-bridge`. One labelled exception: `/updates`' confirmed "update
everything" (below) never asks nemesis for a verdict — TypeScript policy
(`packages/core/src/updates/dispatch.ts`: official taps, checksums, holds, never itself running anything as root)
decides what it runs, and `apps/cli/src/updates/run-step.ts` spawns the package
managers, and a virtualenv's own `python -m pip`, directly.

Any of the following collapses the verdict to **`error`**, which Studio treats as
a **BLOCK** (fail-closed):

- the `nemesis` binary is **missing** or not executable;
- the signature **DB is empty** (`provenance.db.seeded == false`) — detection is
  degraded and Studio refuses to render a green state from it;
- the scan **crashes**;
- the scan **times out** (`--timeout`, fail-closed by design);
- the verdict output is **unparseable** (not the expected `nemesis.verdict/1` JSON).

Studio **never renders a green state from a failed scan.** When the exit code and
the JSON `verdict` field disagree, the bridge takes the **more conservative** of
the two. Decision exit codes are the contract: `0 allow / 10 warn / 20 block /
2 error`.

## In-archive non-remediability and blind spots

Some threats cannot be fixed in place, and Studio says so instead of hiding it:

- **In-archive findings are never remediable.** A malicious member inside a `.zip`
  / `.tar.gz` (`pkg.tar.gz!setup.py`) cannot be edited in place. The only honest
  options are **quarantine** (move the whole archive out of any execution path) or
  **purge** — never a silent "fixed". Disinfection's residual re-scan is
  archive-aware and floors a hard-malware quarantine at **`warn`**, never a false
  `allow`.
- **Blind spots are surfaced explicitly, never hidden.** An encrypted or otherwise
  **unscannable** archive member (`unscannable: true`, or a `blind_spots` entry)
  means the content could not be read. That is **fail-closed**: an unread member
  blocks rather than passes. Studio shows it as *"cannot fix in place — quarantine
  only"* / *"unscannable — fail-closed"*, not as a clean pass.

There is also a **mention-suppression tradeoff**: an accepted finding
(`nemesis ignore`) suppresses *one specific finding* and forces a re-scan so the
new verdict reflects it — it is narrower than trusting a whole source, and the
accept is itself logged.

## Architectural limits we label honestly

Some artifacts never land as files on the host, so a path/archive scanner cannot
vet their built contents. A docker *image pull* and airgapped-container-built
pentest tooling are gated by **recipe**, not by built artifact. Studio labels
these installs **"recipe-scanned; built artifact not file-scannable"** — never
green.

**`/updates` → "update everything" trusts the package managers, not nemesis.**
Answering `y` to *"Do you want to update everything right now? y/N"* runs official
package-manager upgrades — Homebrew formulae and casks from the official taps, npm
and pipx globals, a virtualenv's own pip — and pulls Ollama models that changed
upstream (Ollama pulls are not nemesis-scanned on any path — `/setup`, `/updates pull`,
`prometheus model pull <family:tag>` or this; only `prometheus model pull <org/repo> --staged`
stages Hugging Face weights through the gate). The packages are **not** nemesis-scanned: the default gate blocks every
archive that contains an executable (`HEUR-EXE`, measured on an official Homebrew
bottle), so it cannot vet a binary package. They are trusted to each manager's own
checksum, exactly as when you type the command yourself. This is an owner decision
(2026-10-02) scoped to that one confirmed command: nothing runs without the explicit
`y`; vendor self-updaters, anything needing `sudo`, third-party taps and casks that
publish no checksum are never run by it; and every step is recorded in
`~/.prometheus/config/exec-audit.jsonl`.

**Privileged commands (sudo).** Prometheus may run sudo, but never on its own authority:
every privileged command is shown to the human verbatim and runs only after that human
approves that exact command, every time. One module is the only path to root
(`packages/core/src/agent/system/host/privileged-gate.ts`); `run_command` refuses anything
privileged, and where a kernel sandbox runs (Seatbelt, bubblewrap) it blocks setuid binaries
too — on Linux without bubblewrap the classification is the only barrier. The
approval (Approve once / Deny, Deny by default, a timeout denies, a catastrophic command also
needs its target typed) is bound to the argv, folder and script hash and re-checked just
before spawn. No authorization level (A7 included), `--yes`, grant, MCP client or headless run
can approve; with no human attached the command is returned instead. The password goes from
the TTY or a native askpass dialog straight to sudo, never through Prometheus. The elevator is
resolved only from root-owned system paths. Every request is logged to
`~/.prometheus/audit/sudo.log`.

The root interpreter opens a script only after the password has been typed — seconds after the
gate's last check — so the gate does not rely on the file staying put (`privileged-verify.ts`):
a Python script runs through a fixed loader that, as root, reads the file once, compares the
SHA-256 of those bytes with the approved one and executes the same bytes (a swapped file exits
126); a shell script's approved bytes are passed to the shell with `-c` and the file is never
read again; a script whose whole path is root-controlled runs as it is; anything else is refused
before the human is asked. The PTY relay of terminal mode runs through the same loader. Residual:
the interpreter binary itself is not verified — a user-writable interpreter can be replaced by
anything running as the user.

Terminal mode (an interactive root program in a GUI) requires the askpass route, so the password
never transits the app. Its screen is shown in a dedicated window whose keys main reads from
Electron's `before-input-event` — raised by the browser process for real keyboard input, which
page JavaScript cannot synthesise — and suppresses for the page. There is no IPC input channel,
so no renderer (the app's main page, an extension, the root window's own page) can type into the
root program. Keys pressed before the program draws are dropped; Ctrl+D, Stop, or closing the
root window or the panel's window ends the session. Residual: OS-level input automation the user
has granted Accessibility permission can type into the focused window, as into any terminal.

## Offline / degraded operation

On a first run with no network, the signature and SCA feeds may be absent. The
engine **degrades gracefully** — static, AST, and heuristic layers still gate —
but the signature/IOC/CVE layers are inactive. Studio shows an **amber
"offline — running static analysis only"** state, never a green one, and raises a
global banner if a gate reports `provenance.db.seeded == false`:

> *Your malware DB is empty; hash/IOC/CVE detection is OFF. Seed it before
> installing.*

## Signed verdicts = integrity, not protection

`nemesis gate --sign` HMAC-signs the verdict (`signature: { alg, value, key_id }`,
key in `~/.nemesis/gate.key`). Studio uses this for the audit-log **Verify**
feature (`nemesis verify`), so a tampered verdict in the cache or the IPC channel
shows red.

**Signing is integrity, not protection against a same-uid attacker.** Anyone who
can run as your user can read `gate.key` and forge a signature. Studio does **not**
gate on the signature as a trust root — same posture as the engine, which does not
gate on the signature either. Signing tells you a verdict wasn't altered in
transit; it does not tell you the machine wasn't already compromised.

## In one line

nemesis is the strongest pre-install gate of any local AI tool — every repo,
package, model, plugin, skill, app, worldsim, and MCP server routes through it,
fail-closed (the exceptions are labelled above: `/updates`' confirmed "update
everything", Ollama model pulls, and the model-tooling installers `model install-runner`,
`install-hf-cli` and `install-converter`) — but it is **defense in depth, not a guarantee.** Read every verdict
as *"no known threats found,"* never as *"proven safe."*
