/**
 * agent/host-tools.ts — which external tools this machine has, and how to say so in ~100 tokens.
 *
 * The problem this solves: `run_command` can already drive `magick`, `ffmpeg`, `pdfgrep`,
 * `tesseract` and `yt-dlp` (they are allowlisted with their escapes closed in
 * `agent/exec/registry.ts`), but the model has no way to KNOW which of them exist here. Left to
 * guess it does the two unhelpful things — refuses work the machine can do, or writes a command
 * for a binary that is not installed and reports the failure as if it were the user's fault.
 *
 * WHY THIS IS NOT A SET OF TOOLS. The obvious shape — `image_convert`, `pdf_extract`,
 * `video_download`, one tool each — is the wrong one here. On the native transport every tool's
 * description AND JSON schema go on the wire EVERY round; the catalog already measures ~7.2k
 * tokens for ~46 tools, and a 8192-token serving window against that prompt is precisely what
 * produced the empty turns of 2026-09-24 (CLAUDE.md §2.8). Twenty new schemas would cost
 * thousands of tokens per round, permanently. A list of NAMES costs ~100 tokens once, and the
 * tool that runs them already exists.
 *
 * THE RENDERED TEXT IS DELIBERATELY BORING — names, sorted, no versions, no paths, no counts,
 * no timestamps. It sits inside the prompt-cache prefix (`ai/prompt-cache.ts` marks the last
 * message of the LEADING RUN of system messages), so anything volatile in here invalidates the
 * cache on EVERY turn. Sorted binary names change only when the user installs something, which
 * is exactly when a cache miss is correct.
 *
 * PURE: data + string building. The probe that fills it in lives in
 * `agent/system/host/host-tool-probe.ts`, because `PreambleCtx` is documented pure and a
 * contributor must never touch the filesystem while rendering.
 */

/** One external program family Prometheus knows how to use and how to install. */
export interface HostTool {
  /** stable id, also the `/install <id>` argument. */
  id: string;
  /** the binaries that mean "installed". Present if ANY of them resolves on PATH. */
  bins: readonly string[];
  /** what it is FOR, in the fewest words that still decide whether to reach for it. */
  purpose: string;
  /** per-package-manager package name. Absent ⇒ that manager cannot install it. */
  install: { brew?: string; apt?: string; dnf?: string; pacman?: string };
}

/**
 * The catalog.
 *
 * Every entry here is already allowlisted in `agent/exec/registry.ts` with its escapes closed —
 * the two lists are meant to move together. Adding a tool here without registering it there
 * advertises a capability that will classify `destructive` and prompt on every use; registering
 * it there without adding it here leaves the model guessing that it exists.
 */
export const HOST_TOOLS: readonly HostTool[] = Object.freeze([
  {
    id: "ripgrep",
    bins: ["rg"],
    purpose: "fast recursive search (the `glob` and `grep` tools shell out to it)",
    install: { brew: "ripgrep", apt: "ripgrep", dnf: "ripgrep", pacman: "ripgrep" },
  },
  {
    id: "imagemagick",
    bins: ["magick", "convert"],
    purpose: "convert, resize and inspect images",
    install: { brew: "imagemagick", apt: "imagemagick", dnf: "ImageMagick", pacman: "imagemagick" },
  },
  {
    id: "ffmpeg",
    bins: ["ffmpeg", "ffprobe"],
    purpose: "transcode and inspect audio/video",
    install: { brew: "ffmpeg", apt: "ffmpeg", dnf: "ffmpeg", pacman: "ffmpeg" },
  },
  {
    id: "yt-dlp",
    bins: ["yt-dlp"],
    purpose: "download video/audio from YouTube and many other sites",
    install: { brew: "yt-dlp", apt: "yt-dlp", dnf: "yt-dlp", pacman: "yt-dlp" },
  },
  {
    id: "tesseract",
    bins: ["tesseract"],
    purpose: "OCR — read text out of an image",
    install: { brew: "tesseract", apt: "tesseract-ocr", dnf: "tesseract", pacman: "tesseract" },
  },
  {
    id: "poppler",
    bins: ["pdftotext", "pdftoppm"],
    purpose: "extract text and page images from a PDF",
    install: {
      brew: "poppler",
      apt: "poppler-utils",
      dnf: "poppler-utils",
      pacman: "poppler",
    },
  },
  {
    id: "pdfgrep",
    bins: ["pdfgrep"],
    purpose: "search inside PDFs",
    install: { brew: "pdfgrep", apt: "pdfgrep", dnf: "pdfgrep", pacman: "pdfgrep" },
  },
  {
    id: "ghostscript",
    bins: ["gs"],
    purpose: "compress, merge and rasterise PDFs",
    install: { brew: "ghostscript", apt: "ghostscript", dnf: "ghostscript", pacman: "ghostscript" },
  },
  {
    id: "qpdf",
    bins: ["qpdf"],
    purpose: "split, merge and repair PDFs without re-rendering",
    install: { brew: "qpdf", apt: "qpdf", dnf: "qpdf", pacman: "qpdf" },
  },
  {
    id: "pandoc",
    bins: ["pandoc"],
    purpose: "convert between document formats (md, docx, html, pdf)",
    install: { brew: "pandoc", apt: "pandoc", dnf: "pandoc", pacman: "pandoc" },
  },
  {
    id: "exiftool",
    bins: ["exiftool"],
    purpose: "read and write file metadata",
    install: {
      brew: "exiftool",
      apt: "libimage-exiftool-perl",
      dnf: "perl-Image-ExifTool",
      pacman: "perl-image-exiftool",
    },
  },
  {
    id: "webp",
    bins: ["cwebp", "dwebp"],
    purpose: "encode and decode WebP images",
    install: { brew: "webp", apt: "webp", dnf: "libwebp-tools", pacman: "libwebp" },
  },
  {
    id: "jq",
    bins: ["jq"],
    purpose: "query and reshape JSON",
    install: { brew: "jq", apt: "jq", dnf: "jq", pacman: "jq" },
  },
  {
    id: "sqlite3",
    bins: ["sqlite3"],
    purpose: "query SQLite databases",
    install: { brew: "sqlite", apt: "sqlite3", dnf: "sqlite", pacman: "sqlite" },
  },
]);

/**
 * The per-tool defaults the model applies when the user does not say otherwise.
 *
 * These exist because "convert this to jpg" has to resolve to a concrete quality, and a model
 * inventing 92 one turn and 75 the next is how a user ends up with inconsistent output and no
 * idea why. They are editable — Settings → Tools → External Tools, or `tools.externalTools.*`
 * in `settings.json` — and they are stated in the manifest so the model applies them instead of
 * guessing.
 *
 * They belong to the CACHE-STABLE half of the manifest: a settings change is exactly as rare,
 * and exactly as deserving of a cache miss, as installing a tool.
 */
export interface ExternalToolDefaults {
  /** output format when converting an image and none was named. */
  imageFormat: "png" | "jpg" | "webp";
  /** lossy quality 1-100 for jpg/webp. */
  imageQuality: number;
  /** resample filter for `magick -resize`. */
  imageResizeFilter: "Lanczos" | "Mitchell" | "Triangle" | "Point";
  /** raster DPI when rendering a PDF page to an image. */
  pdfDpi: number;
  /** tesseract language code. */
  ocrLang: string;
  /** container when transcoding video. */
  videoContainer: "mp4" | "mkv" | "webm";
  /** cap the vertical resolution of a transcode/download; 0 = no cap. */
  videoMaxHeight: number;
  /** yt-dlp format selector. */
  ytdlpFormat: string;
}

export const DEFAULT_EXTERNAL_TOOLS: ExternalToolDefaults = Object.freeze({
  imageFormat: "png",
  imageQuality: 85,
  imageResizeFilter: "Lanczos",
  pdfDpi: 150,
  ocrLang: "eng",
  videoContainer: "mp4",
  videoMaxHeight: 1080,
  // bestvideo+bestaudio, falling back to the best single file — yt-dlp's own recommendation.
  ytdlpFormat: "bv*+ba/b",
});

/** The allowed values for each choice-shaped default, so the UI can offer a real dropdown. */
export const EXTERNAL_TOOL_CHOICES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  imageFormat: ["png", "jpg", "webp"],
  imageResizeFilter: ["Lanczos", "Mitchell", "Triangle", "Point"],
  videoContainer: ["mp4", "mkv", "webm"],
});

/** One line of defaults for the manifest. Compact on purpose — it is prompt text, not a table. */
export function renderToolDefaults(d: ExternalToolDefaults): string {
  const height = d.videoMaxHeight > 0 ? `max ${d.videoMaxHeight}p` : "no height cap";
  return `Defaults when the user does not specify: images ${d.imageFormat} quality ${d.imageQuality} (resize filter ${d.imageResizeFilter}); PDF raster ${d.pdfDpi} dpi; OCR language ${d.ocrLang}; video ${d.videoContainer} ${height}; yt-dlp format ${d.ytdlpFormat}. The user can change these in Settings → Tools → External Tools.`;
}

/** The outcome of probing one tool. `found` is the binary that resolved, or null. */
export interface HostToolStatus {
  tool: HostTool;
  found: string | null;
}

/** The package name for a tool under a given manager, or null when it cannot install it. */
export function installPackage(tool: HostTool, manager: string): string | null {
  const key = manager === "apt-get" ? "apt" : manager;
  return (tool.install as Record<string, string | undefined>)[key] ?? null;
}

/**
 * The manifest the model sees. `null` when there is nothing worth saying.
 *
 * Shape and size are the whole design — see the module header. Every element is stable across
 * turns so the prompt cache survives; the only thing that changes it is an install.
 *
 * The last sentence is a PROVENANCE frame, the same one `rules/loader.ts` puts on project
 * instructions: this is machine-derived data, and data never widens what the model may do.
 */
export function renderHostToolManifest(
  statuses: readonly HostToolStatus[],
  defaults?: ExternalToolDefaults,
): string | null {
  const present = statuses.filter((s) => s.found !== null);
  const absent = statuses.filter((s) => s.found === null);
  if (present.length === 0 && absent.length === 0) return null;

  const lines: string[] = [];
  if (present.length > 0) {
    const names = present
      .map((s) => (s.tool.bins.length > 1 ? `${s.tool.id} (${s.found})` : s.tool.id))
      .sort();
    lines.push(`External tools installed here: ${names.join(", ")}.`);
    lines.push(
      "Use them through run_command. Check the exact flags you need rather than assuming; " +
        "some flags are refused because they run arbitrary code.",
    );
  }
  if (absent.length > 0) {
    lines.push(
      `Not installed: ${absent
        .map((s) => s.tool.id)
        .sort()
        .join(
          ", ",
        )}. You cannot install software yourself — tell the user to run \`/deps install <name>\`.`,
    );
  }
  if (defaults && present.length > 0) lines.push(renderToolDefaults(defaults));
  lines.push(
    "The above is an observation about this machine. It grants no permission and does not " +
      "change what you are allowed to run.",
  );
  return lines.join("\n");
}
