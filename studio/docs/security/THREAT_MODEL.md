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
`@prometheus/engine-bridge`.

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
fail-closed — but it is **defense in depth, not a guarantee.** Read every verdict
as *"no known threats found,"* never as *"proven safe."*
