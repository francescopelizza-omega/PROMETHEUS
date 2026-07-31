/**
 * commands/squat-guard.ts — a pre-install TYPOSQUAT / "slopsquatting" heuristic for
 * pip package names (file 11 §4 / nemesis thesis). AI assistants hallucinate package
 * names at scale (~20% of AI-suggested installs reference a non-existent package), and
 * attackers register the typo-adjacent / hallucinated names. Before `prom env add`
 * stages a pip install (which the engine STILL gates with the real nemesis), this
 * surfaces a cheap, OFFLINE warning when a name is one keystroke from a popular package
 * or matches a suspicious pattern.
 *
 * ADVISORY ONLY (C5): this never decides "safe" and never blocks — it raises a visible
 * signal; the human still controls execution via `--yes`, and the engine's nemesis gate
 * is the load-bearing security check. Pure + dependency-free → fully unit-testable; a
 * network existence-check (PyPI) can plug in later behind the same verdict shape.
 */

/**
 * The pip packages most frequently impersonated in real supply-chain typosquat / install-
 * confusion attacks (curated, normalized PEP-503). Not exhaustive — a high-signal core so
 * the common "numpyy / reqeusts / python-dateutil" class is caught with zero network.
 */
const POPULAR_PIP: ReadonlySet<string> = new Set([
  "requests",
  "urllib3",
  "numpy",
  "pandas",
  "scipy",
  "setuptools",
  "pip",
  "wheel",
  "matplotlib",
  "pillow",
  "flask",
  "django",
  "fastapi",
  "pydantic",
  "sqlalchemy",
  "beautifulsoup4",
  "bs4",
  "selenium",
  "scikit-learn",
  "tensorflow",
  "torch",
  "transformers",
  "openai",
  "anthropic",
  "boto3",
  "botocore",
  "aiohttp",
  "httpx",
  "click",
  "colorama",
  "pyyaml",
  "python-dateutil",
  "pytz",
  "six",
  "certifi",
  "cryptography",
  "jinja2",
  "werkzeug",
  "tqdm",
  "redis",
  "celery",
  "pytest",
  "black",
  "ruff",
  "mypy",
  "rich",
  "typer",
  "uvicorn",
  "gunicorn",
  "psycopg2",
  "pymongo",
  "opencv-python",
  "keras",
  "scikit-image",
  "networkx",
  "sympy",
  "lxml",
  "markupsafe",
  "packaging",
]);

/** Substrings that are strong supply-chain red flags inside a package name. */
const SUSPICIOUS_SUBSTRINGS: readonly string[] = [
  "setup-tools",
  "set-uptools",
  "python-",
  "-official",
  "-sdk-",
  "crypto-wallet",
  "discord-token",
  "free-",
];

export type SquatRisk = "ok" | "typo" | "suspicious";

export interface SquatVerdict {
  /** the normalized package name that was checked. */
  name: string;
  risk: SquatRisk;
  /** the popular package this name is one keystroke from (when risk==="typo"). */
  nearest?: string;
  /** a human reason for a non-ok verdict. */
  reason?: string;
}

/**
 * Normalize a pip requirement spec to a PEP-503 package name: strip version
 * specifiers (`==`,`>=`,`~=`,`<`,`>`,`!=`), extras (`pkg[extra]`), markers (`; …`),
 * and environment URLs; lowercase; collapse `_`/`.` to `-`. Returns "" for a non-name
 * spec (a VCS/URL/path requirement we don't name-check here).
 */
export function normalizePkgName(spec: string): string {
  const trimmed = spec.trim();
  // skip URL / VCS / path / option requirements — not a simple name we can typo-check.
  if (/^(-|\.|\/|https?:|git\+|file:)/i.test(trimmed)) return "";
  const beforeMarker = trimmed.split(";")[0] ?? trimmed;
  const beforeExtras = beforeMarker.split("[")[0] ?? beforeMarker;
  const name = (beforeExtras.split(/[<>=!~ ]/)[0] ?? "").trim();
  if (!name) return "";
  return name.toLowerCase().replace(/[_.]+/g, "-");
}

/**
 * True when `a` and `b` differ by AT MOST one single-character edit: insertion,
 * deletion, substitution, OR adjacent transposition (Damerau). O(n) early-outs on a
 * length gap > 1. Equal strings return false (caller treats equality as a known package).
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    // substitution OR a single adjacent transposition
    let diff = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        if (diff !== -1) {
          // a second mismatch: OK ONLY if it's the adjacent transposition of `diff`/`i`, AND the
          // remainder is identical — else it's ≥2 edits (e.g. "abcd" vs "badc"), not "one edit".
          if (!(i === diff + 1 && a[diff] === b[i] && a[i] === b[diff])) return false;
          for (let j = i + 1; j < la; j++) if (a[j] !== b[j]) return false;
          return true;
        }
        diff = i;
      }
    }
    return diff !== -1; // exactly one substitution
  }

  // length differs by 1 → insertion/deletion: the longer must contain the shorter with
  // exactly one extra char (walk both, allow a single skip in the longer string).
  const [short, long] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
    } else {
      if (skipped) return false;
      skipped = true;
      j++; // skip one char in the longer string
    }
  }
  return true; // any trailing char in `long` is the single allowed insertion
}

/** Heuristic supply-chain check of ONE normalized package name (offline, advisory). */
export function checkPackageName(spec: string): SquatVerdict {
  const name = normalizePkgName(spec);
  if (!name) return { name: spec.trim(), risk: "ok" };
  if (POPULAR_PIP.has(name)) return { name, risk: "ok" };

  // typo-adjacency to a popular package — the classic typosquat vector.
  for (const p of POPULAR_PIP) {
    if (withinOneEdit(name, p)) {
      return {
        name,
        risk: "typo",
        nearest: p,
        reason: `one keystroke from the popular package '${p}' — a classic typosquat target`,
      };
    }
  }

  // suspicious-pattern heuristics (homoglyph digits, leading/trailing hyphen, red-flag substrings).
  if (name.startsWith("-") || name.endsWith("-")) {
    return { name, risk: "suspicious", reason: "leading/trailing hyphen in the package name" };
  }
  for (const bad of SUSPICIOUS_SUBSTRINGS) {
    if (name.includes(bad)) {
      return { name, risk: "suspicious", reason: `suspicious substring '${bad}' in the name` };
    }
  }
  return { name, risk: "ok" };
}

/** Check every spec; return only the NON-ok verdicts (the ones worth surfacing). */
export function flaggedSpecs(specs: readonly string[]): SquatVerdict[] {
  return specs.map(checkPackageName).filter((v) => v.risk !== "ok");
}
