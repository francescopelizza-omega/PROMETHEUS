/**
 * ide/path-guard.ts — sensitive-path denylist for the renderer-driven fs IPC.
 *
 * The IDE fs handlers (fsRead/fsWrite) legitimately touch arbitrary project files, so
 * we can't confine them to one workspace root without a trusted-root model the app
 * doesn't yet have. But a compromised renderer must not be able to read the user's
 * private keys / cloud creds or PLANT an SSH authorized_keys via the bridge. This is a
 * defense-in-depth DENYLIST of the highest-value secret targets — it blocks the concrete
 * exfil/persistence exploits without breaking normal project file access.
 *
 * Path is resolved (realpath of the nearest existing ancestor + remainder) so `..`
 * traversal and a symlink through a sensitive dir can't slip past the prefix check.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Normalize a renderer-supplied target to a real fs path: a `file://` URI (what the
 *  editor tabs carry) → its path, an absolute path → itself. node's readFile/writeFile
 *  do NOT accept a `file://` STRING (only a URL object), so this must happen before any
 *  fs call — otherwise every open reads ENOENT. */
export function uriToFsPath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      // malformed file:// (e.g. a relative authority like file://./x) — strip the
      // scheme + percent-decode rather than handing the guard a `file://…` string
      // (which would always fail the isAbsolute check and block the open).
      const stripped = uri.replace(/^file:\/\//, "");
      try {
        return decodeURIComponent(stripped);
      } catch {
        return stripped;
      }
    }
  }
  return uri;
}

/** Directories whose entire subtree is off-limits (resolved absolute paths). */
function sensitiveDirs(): string[] {
  const home = homedir();
  return [
    resolve(home, ".ssh"),
    resolve(home, ".aws"),
    resolve(home, ".gnupg"),
    resolve(home, ".docker"),
    resolve(home, ".kube"),
    resolve(home, ".config", "gh"),
    resolve(home, ".config", "prometheus"), // the URL-pin HMAC key + manifests live here
    resolve(home, ".password-store"),
    "/etc",
    "/private/etc", // macOS real /etc
  ];
}

/** Exact home-relative files that are off-limits regardless of directory rules. */
function sensitiveFiles(): Set<string> {
  const home = homedir();
  return new Set(
    [
      ".netrc",
      ".npmrc",
      ".pypirc",
      ".git-credentials",
      ".gitconfig",
      ".bashrc",
      ".bash_profile",
      ".zshrc",
      ".zprofile",
      ".profile",
    ].map((f) => resolve(home, f)),
  );
}

/** Basenames that are always secrets wherever they live (key material). */
const SENSITIVE_BASENAMES = new Set([
  "authorized_keys",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
]);

/** Resolve a path to a canonical absolute form (realpath of the nearest existing
 *  ancestor, with the not-yet-existing remainder appended). */
function canonical(p: string): string {
  let abs = resolve(p);
  // walk up to the first existing ancestor, realpath it, re-append the tail.
  const tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break; // reached the root
    tail.unshift(basename(cur));
    cur = parent;
  }
  try {
    abs = resolve(realpathSync(cur), ...tail);
  } catch {
    /* realpath failed (perms/race) — fall back to the lexical resolve */
  }
  return abs;
}

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Throw if `uri` resolves to a sensitive secret path; otherwise return the canonical
 * absolute path. A RELATIVE input is resolved to absolute (against cwd) rather than
 * rejected — the editor may hand a workspace-relative path (e.g. `README.md` from a
 * relative root), and `readFile` would resolve it the same way; the sensitive-path
 * checks below still run on the resolved absolute path, so this is safe.
 */
export function assertNotSensitivePath(uri: string): string {
  const fsPath = uriToFsPath(uri);
  // canonical() runs resolve() → relative paths become absolute (against cwd) here.
  const abs = canonical(fsPath);
  if (SENSITIVE_BASENAMES.has(basename(abs))) {
    throw new Error(`refusing access to a sensitive key file: ${basename(abs)}`);
  }
  if (sensitiveFiles().has(abs)) {
    throw new Error("refusing access to a sensitive credential/rc file");
  }
  for (const dir of sensitiveDirs()) {
    if (isUnder(abs, dir)) {
      throw new Error(`refusing access under a sensitive directory: ${dir}`);
    }
  }
  return abs;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The WORKING-SET guard (handoff §3).
 *
 * `assertNotSensitivePath` above is a DENYLIST: it stops ~/.ssh and /etc, and nothing
 * else. That leaves every other absolute path on the machine writable by an agent
 * that asks for it — the exact hole the CLI closed on 08-07 with
 * `isPathAllowed(abs, roots)` in its applier.
 *
 * This is the desktop's half of that fix, and it lives in MAIN on purpose: §3 says
 * "the applier's scope guard stays on regardless" of what the permission card shows.
 * A renderer that is compromised, buggy, or simply skipped cannot write outside the
 * working set by not rendering a card.
 *
 * Approval is explicit and per-path: the renderer's permission card, once the human
 * says yes, registers that ONE absolute path here. Nothing grants a wildcard.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The active workspace roots. Empty = unset, which means "do not gate" (see below). */
let workingSetRoots: string[] = [];

/**
 * Roots a HUMAN chose, through main's own native folder picker.
 *
 * This is the ceiling. `setWorkingSetRoots` is an IPC handler, so its argument is whatever
 * the renderer sent — and a renderer is exactly the process this guard exists to survive. It
 * accepted that list verbatim, so a compromised or buggy renderer could declare `["/"]` and
 * put the entire filesystem inside the working set, or declare `[]` and turn the guard off
 * altogether. Either one defeats a check whose whole stated purpose is that "a renderer that
 * is compromised, buggy, or simply skipped cannot write outside the working set".
 *
 * Main owns `dialog.showOpenDialog`, so main knows which directories a human actually picked.
 * That fact — not the renderer's assertion — is what may widen scope.
 */
const grantedRoots = new Set<string>();

/** Absolute paths a human explicitly approved for writing outside the working set. */
const approvedOutside = new Set<string>();

/**
 * Record a directory the HUMAN chose in main's native picker. The only widening operation.
 *
 * Called from the `folder:open` handler after the dialog resolves — i.e. only ever with a path
 * the operating system's own file chooser returned, which no renderer can forge.
 */
export function grantWorkingSetRoot(dir: string): void {
  if (typeof dir !== "string" || !dir) return;
  const before = grantedRoots.size;
  grantedRoots.add(canonical(uriToFsPath(dir)));
  if (grantedRoots.size !== before) saveGrants();
}

/** The directories a human has picked this session (canonical absolute paths). */
export function getGrantedRoots(): readonly string[] {
  return [...grantedRoots];
}

/** Test seam: forget every grant (a fresh app). */
export function clearGrantedRoots(): void {
  grantedRoots.clear();
  persistPath = null;
}

/* ── grants survive a restart, because the human's choice did ───────────────── */

/**
 * Where the grant list is persisted, under `app.getPath("userData")`.
 *
 * MAIN-owned, never renderer-supplied — the whole point is that the renderer cannot add to
 * this list. Null until `initGrantedRoots` runs, which also makes the persistence optional
 * for unit tests.
 */
let persistPath: string | null = null;

/**
 * Load the persisted grants and start recording new ones.
 *
 * Without this the guard would be OFF for the most common way a project is opened. The
 * recents list lives in the RENDERER's localStorage, so clicking "recent project" never
 * touches main's folder dialog — the roots would arrive ungranted, be refused, and the
 * fallback (no grants ⇒ no guard) would leave every agent write unchecked on the path
 * almost every user takes. A folder in this file was chosen by a human through the OS picker
 * at some point; that is exactly the fact the guard needs, and it does not expire when the
 * app closes.
 *
 * Fail-soft: an unreadable or corrupt file yields no grants, which is the SAFE direction —
 * the human re-picks the folder once and it is granted again.
 */
export function initGrantedRoots(userDataDir: string): void {
  persistPath = join(userDataDir, "workspace-grants.json");
  try {
    const raw: unknown = JSON.parse(readFileSync(persistPath, "utf8"));
    if (Array.isArray(raw)) {
      for (const r of raw) {
        if (typeof r === "string" && r) grantedRoots.add(canonical(uriToFsPath(r)));
      }
    }
  } catch {
    /* absent or corrupt ⇒ start with nothing granted */
  }
}

/** Persist the grant list. Never throws — a failed write costs a re-pick, not a crash. */
function saveGrants(): void {
  if (!persistPath) return;
  try {
    mkdirSync(dirname(persistPath), { recursive: true });
    writeFileSync(persistPath, JSON.stringify([...grantedRoots], null, 2), "utf8");
  } catch {
    /* best effort */
  }
}

/**
 * Declare the workspace roots the agent may write inside — NARROWING ONLY.
 *
 * The renderer says which of the human's granted directories is the current workspace. Every
 * declared root must lie inside one the human actually picked; anything else is dropped and
 * counted, because silently ignoring an attempt to widen scope is how a guard stops being
 * evidence of anything. The return value reports what was refused so the caller can log it.
 *
 * An EMPTY (or wholly refused) declaration no longer disables the check. It used to, and that
 * was the second half of the same hole: `setWorkingSetRoots([])` was a one-call bypass. With
 * grants in hand the guard falls back to THEM — the human's own choices — rather than to
 * "allow everything".
 *
 * With NO grants at all the guard still permits, and that is deliberate rather than an
 * oversight: `ideFsWrite` is also the editor's ordinary save path, so a fresh window with
 * nothing ever opened must still be able to save a loose file the user typed into. There is no
 * working set to be outside of yet, because the human has not chosen one.
 */
export function setWorkingSetRoots(roots: readonly string[]): {
  accepted: number;
  refused: string[];
} {
  const declared = roots
    .filter((r): r is string => typeof r === "string" && r.length > 0)
    .map((r) => canonical(uriToFsPath(r)));
  const refused: string[] = [];
  const accepted: string[] = [];
  for (const r of declared) {
    // inside a granted root, or exactly one of them
    if ([...grantedRoots].some((g) => r === g || isUnder(r, g))) accepted.push(r);
    else refused.push(r);
  }
  // Nothing legitimate declared ⇒ fall back to the human's grants, never to "no guard".
  workingSetRoots = accepted.length > 0 ? accepted : [...grantedRoots];
  // a root change invalidates prior approvals — they were granted against the old scope.
  approvedOutside.clear();
  return { accepted: accepted.length, refused };
}

/** The roots currently in force (canonical absolute paths). */
export function getWorkingSetRoots(): readonly string[] {
  return workingSetRoots;
}

/** Whether `uri` resolves inside the working set (true when no roots are set). */
export function isInsideWorkingSet(uri: string): boolean {
  if (workingSetRoots.length === 0) return true;
  const abs = canonical(uriToFsPath(uri));
  return workingSetRoots.some((root) => isUnder(abs, root));
}

/** Record a human's explicit approval to write ONE path outside the working set. */
export function approveOutsideWorkingSet(uri: string): void {
  approvedOutside.add(canonical(uriToFsPath(uri)));
}

/** Forget every out-of-scope approval (a new session / a denied prompt). */
export function clearOutsideApprovals(): void {
  approvedOutside.clear();
}

/**
 * The fail-closed applier check. Throws unless the target is inside the working set or
 * was explicitly approved. Call it on EVERY mutating fs path in main — write, delete,
 * create, mkdir, rename (both ends).
 */
export function assertInsideWorkingSet(uri: string): string {
  const abs = canonical(uriToFsPath(uri));
  if (workingSetRoots.length === 0) return abs;
  if (workingSetRoots.some((root) => isUnder(abs, root))) return abs;
  if (approvedOutside.has(abs)) return abs;
  throw new Error(
    `refusing to write outside the working set (not approved): ${abs}. ` +
      `Working set: ${workingSetRoots.join(", ")}`,
  );
}
