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
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
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
