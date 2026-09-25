/**
 * agent/exec/registry.ts — what each program IS, and which of its flags are a shell in disguise.
 *
 * The parser (parse.ts) guarantees we know the exact argv of every stage. This module answers
 * the next question: how dangerous is that argv? It maps `argv[0]` — plus, where it matters,
 * `argv[1]` — onto the SAME `AuthCategory` values the A0–A7 ladder already uses, so a command
 * needs no new permission concept.
 *
 * Two rules carry almost all of the weight:
 *
 *   1. **Unknown ⇒ `destructive`.** A program the registry has never heard of is not an error
 *      and not a block — it is classified at the top of the scale, so it always reaches a
 *      human. The registry grows by evidence. Guessing "probably fine" is how a list like this
 *      rots into a rubber stamp.
 *
 *   2. **Deny-flags are not optional.** Half the programs on any allowlist can execute
 *      arbitrary code if you pass the right flag: `git -c core.pager=…`, `find -exec`,
 *      `awk 'BEGIN{system(…)}'`, `tar --to-command`, `rsync -e`, `ssh -o ProxyCommand`,
 *      `xargs`, `sed -e s///e`, `perl -e`. Without these, an allowlist that says "git is
 *      read-only" is a lie — `git` becomes `sh` and every tier above it is decoration.
 *
 * PURE: data + lookups, no IO. The deny-flag list is the part to review hardest.
 */

import type { AuthCategory } from "../authorization.js";

/** How a program (or one of its subcommands) is classified. */
export type ExecTier = AuthCategory;

/** A denied flag, with the escape it closes — the reason goes in the refusal the model sees. */
export interface DeniedFlag {
  re: RegExp;
  why: string;
}

export interface ProgramSpec {
  /** the tier when no subcommand rule matches. */
  tier: ExecTier;
  /** per-subcommand tiers, keyed on `argv[1]` (git status vs git push). */
  subcommands?: Readonly<Record<string, ExecTier>>;
  /** flags that turn this program into an arbitrary-code runner. */
  denyFlags?: readonly DeniedFlag[];
  /** true when a subcommand is REQUIRED — a bare `git` is meaningless, a bare `ls` is not. */
  needsSubcommand?: boolean;
  /**
   * Global options that CONSUME the next argument, so the subcommand scan can skip past
   * their values.
   *
   * Without this, "the first token that is not a flag" finds the option's VALUE:
   * `git -C . reset --hard` looked like the subcommand was `.` (unknown ⇒ the program's own
   * tier, `command`, auto at A4) and `git -C status reset --hard` looked like `status`
   * (`read`, auto at A1 — a five-rung downgrade needing only a directory named `status`).
   */
  valueOptions?: readonly string[];
}

/* ── the escapes, named once and reused ─────────────────────────────────────*/

const RUNS_CODE = (what: string): string =>
  `\`${what}\` runs an arbitrary command, which bypasses the per-command checks`;

/**
 * The registry.
 *
 * Tiers use the ladder's vocabulary: `read` (auto at A1) · `command` (A4) · `install` (A5,
 * anything touching the network or fetching remote code) · `destructive` (A6).
 */
export const PROGRAMS: Readonly<Record<string, ProgramSpec>> = Object.freeze({
  /* ── inspection ──────────────────────────────────────────────────────────*/
  ls: { tier: "read" },
  cat: { tier: "read" },
  head: { tier: "read" },
  // `-F` is `--follow=name --retry`; anchoring on `-f` alone let it through.
  tail: {
    tier: "read",
    denyFlags: [{ re: /^-[fF]$|^--follow|^--retry$/, why: "`tail -f` never exits" }],
  },
  wc: { tier: "read" },
  file: { tier: "read" },
  stat: { tier: "read" },
  du: { tier: "read" },
  df: { tier: "read" },
  pwd: { tier: "read" },
  echo: { tier: "read" },
  // `printf` is echo with a format string; the format is data, not code.
  printf: { tier: "read" },
  date: { tier: "read" },
  uname: { tier: "read" },
  whoami: { tier: "read" },
  id: { tier: "read" },
  hostname: { tier: "read" },
  uptime: { tier: "read" },
  sw_vers: { tier: "read" },
  sysctl: { tier: "read", denyFlags: [{ re: /^-w$/, why: "`sysctl -w` writes kernel state" }] },
  lscpu: { tier: "read" },
  free: { tier: "read" },
  ps: { tier: "read" },
  lsof: { tier: "read" },
  which: { tier: "read" },
  type: { tier: "read" },
  printenv: { tier: "read" },
  basename: { tier: "read" },
  dirname: { tier: "read" },
  realpath: { tier: "read" },
  readlink: { tier: "read" },
  sort: { tier: "read" },
  uniq: { tier: "read" },
  cut: { tier: "read" },
  tr: { tier: "read" },
  rev: { tier: "read" },
  column: { tier: "read" },
  diff: { tier: "read" },
  cmp: { tier: "read" },
  md5sum: { tier: "read" },
  shasum: { tier: "read" },
  sha256sum: { tier: "read" },
  nvidia_smi: { tier: "read" },
  "nvidia-smi": { tier: "read" },
  system_profiler: { tier: "read" },
  vm_stat: { tier: "read" },
  // Benign utilities that turned up as "unknown" in real use. The fail-closed default did
  // its job — they prompted — but a registry that classifies `sleep` as destructive trains
  // the operator to approve without reading, which is the failure mode a prompt exists to
  // prevent. Add by EVIDENCE, which is what these are.
  sleep: { tier: "read" },
  true: { tier: "read" },
  false: { tier: "read" },
  seq: { tier: "read" },
  yes: { tier: "read", denyFlags: [{ re: /.*/, why: "`yes` never terminates" }] },
  tee: { tier: "command" },
  nl: { tier: "read" },
  paste: { tier: "read" },
  join: { tier: "read" },
  comm: { tier: "read" },
  fold: { tier: "read" },
  expand: { tier: "read" },
  // `tsc` WRITES compiled output — it is not an inspection command.
  tsc: { tier: "command" },

  grep: {
    tier: "read",
    // GNU grep can run a program per match via --devices/--directories? No — but -f reads a
    // pattern FILE, which is fine. The real risk is none; kept explicit for review.
  },
  // the deprecated spellings are still what a model reaches for; same tier as `grep`.
  egrep: { tier: "read" },
  fgrep: { tier: "read" },
  rg: { tier: "read", denyFlags: [{ re: /^--pre$|^--pre=/, why: RUNS_CODE("rg --pre") }] },
  find: {
    tier: "read",
    denyFlags: [
      { re: /^-exec$|^-execdir$/, why: RUNS_CODE("find -exec") },
      { re: /^-ok$|^-okdir$/, why: RUNS_CODE("find -ok") },
      { re: /^-delete$/, why: "`find -delete` removes files" },
      { re: /^-fprintf$|^-fprint$/, why: "`find -fprint*` writes arbitrary files" },
    ],
  },
  /**
   * `awk` is a PROGRAMMING LANGUAGE, not a filter, and it is demoted accordingly.
   *
   * An adversarial review found two escapes past a deny-list that already caught `system()`:
   * `"cmd" | getline` (awk's other command-execution primitive) and `printf … > "file"`
   * (an arbitrary write that produces no parsed redirect, so the path guard structurally
   * cannot see it). There will be more — `close()`, `ENVIRON`, gawk's `|&`. Enumerating the
   * escapes of a Turing-complete language is a losing game, so it classifies as
   * `destructive` and always reaches a human. The deny-flags stay as a second layer.
   *
   * `sed` keeps `read` because its dangerous surface really is a short list (`-i`, `w`, `e`)
   * and `sed 's/a/b/ f'` as a filter is both common and genuinely a read.
   */
  awk: {
    tier: "destructive",
    denyFlags: [
      { re: /system\s*\(/, why: RUNS_CODE("awk system()") },
      { re: /\|\s*&|\|\s*getline|getline\s*<|\bclose\s*\(/, why: RUNS_CODE("awk cmd | getline") },
      { re: /\bprintf?\b[^\n]*>/, why: "`awk print > file` writes an arbitrary file" },
    ],
  },
  sed: {
    tier: "read",
    denyFlags: [
      // `-i.bak` is the documented suffix form — `^-i$` missed it entirely, and
      // `sed -i.bak 's/.*/pwned/' ~/.ssh/authorized_keys` was tier `read` ⇒ A1 auto.
      { re: /^-i|^--in-place/, why: "`sed -i` edits files in place — use propose_edit" },
      { re: /[;}]\s*[wW]\s/, why: "`sed w` writes arbitrary files" },
      { re: /s.*\/[a-z]*e[a-z]*$/, why: RUNS_CODE("sed s///e") },
    ],
  },
  jq: { tier: "read" },
  xargs: {
    // xargs' entire purpose is running a program built from stdin — the argv we validate is
    // not the argv that runs. There is no safe subset worth the review cost.
    tier: "destructive",
    denyFlags: [{ re: /.*/, why: RUNS_CODE("xargs") }],
  },

  /* ── git ─────────────────────────────────────────────────────────────────*/
  git: {
    tier: "command",
    needsSubcommand: true,
    subcommands: {
      status: "read",
      diff: "read",
      log: "read",
      show: "read",
      branch: "read",
      remote: "read",
      "rev-parse": "read",
      "ls-files": "read",
      blame: "read",
      describe: "read",
      shortlog: "read",
      tag: "read",
      stash: "command",
      add: "command",
      commit: "command",
      checkout: "command",
      switch: "command",
      restore: "command",
      merge: "command",
      rebase: "command",
      cherry: "command",
      "cherry-pick": "command",
      init: "command",
      mv: "command",
      fetch: "install",
      pull: "install",
      push: "install",
      clone: "install",
      submodule: "install",
      reset: "destructive",
      clean: "destructive",
      "filter-branch": "destructive",
      rm: "destructive",
    },
    valueOptions: ["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"],
    denyFlags: [
      // `git -c core.pager=sh`, `-c alias.x=!sh`, `-c core.sshCommand=…` are all shells.
      { re: /^-c$|^--config-env=/, why: RUNS_CODE("git -c <config>") },
      { re: /^--exec-path=/, why: RUNS_CODE("git --exec-path") },
      { re: /^--upload-pack=|^--receive-pack=/, why: RUNS_CODE("git --upload-pack") },
      { re: /^--force$|^-f$|^--force-with-lease/, why: "force-push / forced overwrite" },
    ],
  },

  /**
   * `gh` — the GitHub CLI. Unlike `git`, `gh`'s CLI is noun+verb (`gh pr merge`, not `gh
   * merge`), so subcommand keys here are the COMPOUND `"<noun> <verb>"` — `classifyStage`
   * tries that two-token key before falling back to the noun alone.
   *
   * Opening a PR / leaving a comment is the `command` tier, same rung as `git commit`. Merging
   * or closing a PR is a step up: unlike a local `git merge`, it mutates the remote repo over
   * the network (like `git push`/`fetch`) AND is far harder to walk back once other people and
   * CI have reacted to it — so it lands at `install`, next to git's own remote-mutating verbs.
   * `gh auth`/`gh config` touch stored credentials / persistent settings — also `install`.
   */
  gh: {
    tier: "command",
    needsSubcommand: true,
    subcommands: {
      "pr create": "command",
      "pr comment": "command",
      "pr merge": "install",
      "pr close": "install",
      auth: "install",
      config: "install",
    },
  },

  /* ── local mutation ──────────────────────────────────────────────────────*/
  mkdir: { tier: "command" },
  touch: { tier: "command" },
  cp: { tier: "command" },
  mv: { tier: "command" },
  ln: { tier: "command" },
  chmod: {
    tier: "command",
    // `-Rf` / `-fR` are the same flag bundled; exact anchors missed both.
    denyFlags: [{ re: /^-[a-zA-Z]*R|^--recursive/, why: "recursive permission change" }],
  },

  /* ── network / remote code ───────────────────────────────────────────────*/
  curl: {
    tier: "install",
    denyFlags: [
      // `-O`, `--output=…` and `--output-dir` all write; anchoring on `-o`/`--output` missed them.
      {
        re: /^-[oO]$|^--output/,
        why: "writing a downloaded file — fetch it with web_fetch instead",
      },
      { re: /^-K$|^--config$/, why: RUNS_CODE("curl -K") },
    ],
  },
  wget: { tier: "install" },
  brew: {
    tier: "install",
    needsSubcommand: true,
    subcommands: { list: "read", info: "read", "--version": "read" },
  },
  pip: {
    tier: "install",
    needsSubcommand: true,
    subcommands: { list: "read", show: "read", freeze: "read" },
  },
  pip3: {
    tier: "install",
    needsSubcommand: true,
    subcommands: { list: "read", show: "read", freeze: "read" },
  },
  npm: {
    tier: "install",
    needsSubcommand: true,
    subcommands: { ls: "read", list: "read", view: "read", outdated: "read" },
  },
  pnpm: {
    tier: "install",
    needsSubcommand: true,
    subcommands: { ls: "read", list: "read", outdated: "read" },
  },
  rsync: { tier: "install", denyFlags: [{ re: /^-e$|^--rsh=/, why: RUNS_CODE("rsync -e") }] },
  ssh: {
    tier: "install",
    denyFlags: [
      { re: /^-o$/, why: RUNS_CODE("ssh -o ProxyCommand") },
      { re: /^ProxyCommand=|^LocalCommand=/i, why: RUNS_CODE("ssh ProxyCommand") },
    ],
  },
  scp: { tier: "install" },

  /* ── media, documents and OCR ────────────────────────────────────────────
   *
   * These are the host tools a model reaches for when asked to convert an image, pull text
   * out of a PDF, or fetch a video — the ones this registry had never heard of, so every one
   * of them classified `destructive` and prompted. They are allowlisted here at the tier that
   * matches what they actually do: `read` when the program only reads, `command` as soon as it
   * writes a file of its own, `install` when it needs the network.
   *
   * Half of them can execute arbitrary code given the right flag, and those flags are the
   * point of this block — see each `denyFlags` entry. What CANNOT be caught by argv (an
   * ImageMagick delegate triggered by a crafted input file, an ffmpeg demuxer bug) is left to
   * the layer built for it: the OS sandbox, which confines writes to the working set and
   * denies the network below A5.
   */
  // Readers. No output file of their own, so they stay at the bottom of the ladder.
  pdfgrep: { tier: "read" },
  identify: { tier: "read" },
  ffprobe: { tier: "read" },

  // ImageMagick. `@file` is a FILE-REFERENCE primitive: `convert @/etc/passwd …` reads a path
  // the caller never named, and `msl:`/`mvg:` are ImageMagick's own scripting languages —
  // `msl:script.xml` is an interpreter, not an image.
  magick: {
    tier: "command",
    denyFlags: [
      { re: /^@/, why: "`@file` makes ImageMagick read a file the command never named" },
      { re: /^(msl|mvg|ephemeral):/i, why: RUNS_CODE("an MSL/MVG script") },
    ],
  },
  convert: {
    tier: "command",
    denyFlags: [
      { re: /^@/, why: "`@file` makes ImageMagick read a file the command never named" },
      { re: /^(msl|mvg|ephemeral):/i, why: RUNS_CODE("an MSL/MVG script") },
    ],
  },
  // `-protocol_whitelist` re-enables `file:`/`concat:` inside a playlist, the long-standing
  // route from "transcode this HLS stream" to "read an arbitrary local file into the output".
  ffmpeg: {
    tier: "command",
    denyFlags: [
      {
        re: /^-protocol_whitelist$/,
        why: "`-protocol_whitelist` re-enables file:/concat: inside a playlist, which reads arbitrary local files",
      },
    ],
  },
  // Ghostscript's `-dSAFER` is the sandbox; the two flags that switch it off are the escape.
  gs: {
    tier: "command",
    denyFlags: [
      { re: /^-dNOSAFER$|^-dDELAYSAFER$/, why: RUNS_CODE("ghostscript with -dSAFER disabled") },
    ],
  },
  qpdf: { tier: "command" },
  pdftoppm: { tier: "command" },
  dwebp: { tier: "command" },
  /**
   * The sqlite3 CLI is a shell with a database attached, and the escapes are POSITIONAL, not
   * flags: `sqlite3 db ".shell id"` runs `id`, `.system` is its twin, `.once |cmd` and
   * `.output |cmd` pipe a query's output INTO a command, `.load` loads a binary extension
   * (arbitrary native code), and `.import`/`.excel`/`.expert` each read or spawn. `-cmd` is the
   * same thing spelled as a flag.
   *
   * It stays at `command` rather than `read` for the same reason: a plain `SELECT` is harmless,
   * but a write statement is indistinguishable from one by argv alone.
   */
  sqlite3: {
    tier: "command",
    denyFlags: [
      { re: /^-cmd$/, why: RUNS_CODE("sqlite3 -cmd") },
      {
        re: /^\s*\.(shell|system|once|output|load|import|excel|expert)\b/i,
        why: RUNS_CODE("a sqlite3 dot-command (.shell/.system/.load pipe into or load code)"),
      },
      { re: /\|/, why: "a sqlite3 argument containing `|` pipes output into a command" },
    ],
  },
  // Both filter flags run a program; `--pdf-engine` launches one, which is exactly the
  // argv[0]-invisible indirection that put `env` and `timeout` in FORBIDDEN.
  pandoc: {
    tier: "command",
    denyFlags: [
      { re: /^--lua-filter$|^--filter$/, why: RUNS_CODE("a pandoc filter") },
      { re: /^--pdf-engine$/, why: "`--pdf-engine` launches another program under pandoc's name" },
    ],
  },
  cwebp: { tier: "command" },
  optipng: { tier: "command" },
  jpegoptim: { tier: "command" },
  tesseract: { tier: "command" },
  pdftotext: { tier: "command" },
  // exiftool is Perl, and three of its options take PERL: `-config` loads a Perl config file,
  // `-if` evaluates a Perl condition, and `-p`'s advanced formatting `${tag;expr}` evaluates
  // `expr`. Without these it is the most capable metadata tool available; with them it is perl.
  exiftool: {
    tier: "command",
    denyFlags: [
      { re: /^-config$/, why: RUNS_CODE("an exiftool -config file (it is Perl)") },
      { re: /^-if$/, why: RUNS_CODE("exiftool -if (the condition is Perl)") },
      { re: /^-p$/, why: RUNS_CODE("exiftool -p (${tag;expr} formatting evaluates Perl)") },
      { re: /^-@$/, why: "`-@ argfile` takes arguments from a file, past every check here" },
    ],
  },
  // yt-dlp: `install` because it needs the NETWORK, and the sandbox ties network to A5 — at
  // A5+ a "download this video" request therefore runs end to end with no prompt, which is the
  // whole point. Its deny list is the longest here because it has the most ways out:
  //   --exec / --exec-before-download  run an arbitrary shell command per download
  //   --downloader / --external-downloader  hand the transfer to another binary
  //   --plugin-dirs  loads Python plugins from a directory
  //   --config-location / --config  a config file may contain any of the above
  //   --load-info-json  same, via a JSON field
  //   --cookies-from-browser / --cookies  send the user's session cookies to whatever host
  //     the URL names — credential exfiltration with no other symptom
  // `-o`, `-P` and `--paths` are deliberately NOT denied: they are how `/in` aims the download.
  "yt-dlp": {
    tier: "install",
    denyFlags: [
      { re: /^--exec(-before-download)?(=|$)/, why: RUNS_CODE("yt-dlp --exec") },
      { re: /^--(external-)?downloader(-args)?(=|$)/, why: RUNS_CODE("an external downloader") },
      { re: /^--plugin-dirs(=|$)/, why: RUNS_CODE("yt-dlp plugins") },
      { re: /^--config(-location)?(=|$)/, why: RUNS_CODE("a yt-dlp config file") },
      { re: /^--load-info-json(=|$)/, why: RUNS_CODE("a yt-dlp info JSON") },
      {
        re: /^--cookies(-from-browser)?(=|$)/,
        why: "sending your browser session cookies to the download host — do it yourself if you mean to",
      },
    ],
  },

  /* ── interpreters: a shell by any other name ─────────────────────────────*/
  python: { tier: "destructive", denyFlags: [{ re: /^-c$/, why: RUNS_CODE("python -c") }] },
  python3: { tier: "destructive", denyFlags: [{ re: /^-c$/, why: RUNS_CODE("python3 -c") }] },
  node: {
    tier: "destructive",
    denyFlags: [{ re: /^-e$|^--eval$|^-p$|^--print$/, why: RUNS_CODE("node -e") }],
  },
  perl: { tier: "destructive", denyFlags: [{ re: /^-e$|^-E$/, why: RUNS_CODE("perl -e") }] },
  ruby: { tier: "destructive", denyFlags: [{ re: /^-e$/, why: RUNS_CODE("ruby -e") }] },

  /* ── destructive ─────────────────────────────────────────────────────────*/
  rm: { tier: "destructive" },
  rmdir: { tier: "destructive" },
  kill: { tier: "destructive" },
  killall: { tier: "destructive" },
  pkill: { tier: "destructive" },
  tar: {
    tier: "command",
    denyFlags: [
      { re: /^--to-command=|^--use-compress-program=/, why: RUNS_CODE("tar --to-command") },
    ],
  },
});

/** Programs that must NEVER run, at any level, however they are reached. */
export const FORBIDDEN: Readonly<Record<string, string>> = Object.freeze({
  sudo: "privilege escalation — the agent may never elevate (use propose_elevated)",
  doas: "privilege escalation — the agent may never elevate",
  su: "privilege escalation — the agent may never elevate",
  sh: "a shell would bypass every per-command check",
  bash: "a shell would bypass every per-command check",
  zsh: "a shell would bypass every per-command check",
  dash: "a shell would bypass every per-command check",
  fish: "a shell would bypass every per-command check",
  ksh: "a shell would bypass every per-command check",
  mkfs: "filesystem format",
  dd: "raw device write",
  fdisk: "disk partitioning",
  diskutil: "disk management",
  parted: "disk partitioning",
  shutdown: "power control",
  reboot: "power control",
  halt: "power control",
  poweroff: "power control",
  nc: "arbitrary network listener / reverse shell",
  ncat: "arbitrary network listener / reverse shell",
  netcat: "arbitrary network listener / reverse shell",
  telnet: "cleartext remote shell",
  chown: "ownership change (needs privilege to be useful, and is destructive when it works)",
  crontab: "installs a persistent scheduled job",
  // PROGRAM LAUNCHERS. Each runs `LAUNCHER [opts] COMMAND [args]`, so the program that
  // actually executes is argv[1] — which the classifier never inspects, because it reasons
  // about argv[0]. `env` was on the ALLOWLIST at tier `read`, which meant `env sh -c id`
  // classified as a read and auto-approved at A1: eight characters defeated the forbidden
  // list, the deny-flags and the whole tier ladder at once. Classifying a launcher is only
  // meaningful if you classify what it launches, and that is a different design.
  env: "runs another program — the launched command would escape every per-program check",
  nice: "runs another program — see `env`",
  nohup: "runs another program — see `env`",
  timeout: "runs another program — see `env`",
  setsid: "runs another program — see `env`",
  stdbuf: "runs another program — see `env`",
  script: "runs another program (and records a tty) — see `env`",
  watch: "re-runs another program forever — see `env`",
  launchctl: "installs a persistent background job",
  systemctl: "controls system services",
});

/**
 * Why this program may never run, or null when it is merely classified.
 *
 * Checks the basename AND the part before its first dot, because the dangerous programs come
 * in families: `mkfs.ext4`, `mkfs.xfs` and `mkfs.vfat` are all `mkfs`, and a denylist that
 * only knows the bare name lets every variant through. The same fold helpfully maps
 * `python3.11` onto `python3` for the classifier below.
 */
export function forbiddenReason(program: string): string | null {
  const base = basename(program);
  const family = base.includes(".") ? (base.split(".")[0] as string) : base;
  return FORBIDDEN[base] ?? FORBIDDEN[family] ?? null;
}

/** Strip any directory part: `/usr/bin/sudo` and `sudo` are the same program. */
export function basename(program: string): string {
  const p = (program ?? "").replace(/\\/g, "/");
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * The spec for a program, or undefined when the registry has never heard of it.
 *
 * Falls back to the pre-dot family so a versioned interpreter (`python3.11`, `pip3.12`)
 * inherits its family's tier and deny-flags rather than classifying as "unknown" — which
 * would be the RIGHT default for a genuinely unknown binary but the wrong one here, since
 * `python3.11 -c` is exactly as much of a shell as `python3 -c`.
 */
export function programSpec(program: string): ProgramSpec | undefined {
  const base = basename(program);
  if (PROGRAMS[base]) return PROGRAMS[base];
  const family = base.includes(".") ? (base.split(".")[0] as string) : "";
  return family ? PROGRAMS[family] : undefined;
}
