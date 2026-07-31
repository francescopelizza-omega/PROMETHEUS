/**
 * ide/fonts/registry.ts — the monospace font catalog for the PyCharm-style font
 * picker (Settings → Fonts), shared by the editor (Monaco) and the terminal (xterm).
 *
 * `bundled` families are shipped OFFLINE via @fontsource (imported in main.tsx) so
 * they render on any machine with no font install and no network/CSP fetch —
 * these are the coding fonts PyCharm/the JetBrains IDEs ship or recommend.
 * `bundled: false` families are the platform monospace fonts PyCharm also lists
 * (Menlo/Consolas/…); they render only where the OS provides them and otherwise
 * fall through the shared fallback tail.
 *
 * Keep the bundled entries in sync with the @fontsource imports in
 * renderer/main.tsx — the picker offers a family, main.tsx must load its @font-face.
 */

/** The fallback tail appended to every family so an unavailable font degrades to a
 *  sane platform monospace instead of the browser default (Courier). */
export const MONO_FALLBACK = 'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace';

export interface MonoFontFamily {
  /** stable key persisted in font settings (never the display label). */
  id: string;
  /** the exact CSS family name (must match the @font-face / OS font name). */
  family: string;
  /** display label for the picker (PyCharm-style). */
  label: string;
  /** true = shipped offline via @fontsource; false = relies on an OS install. */
  bundled: boolean;
  /** the family provides programming ligatures (calt) — gates the ligatures toggle. */
  ligatures: boolean;
  /** short note shown in the picker (e.g. the PyCharm default). */
  note?: string;
}

/**
 * The catalog. Bundled coding fonts first (JetBrains Mono default), then the
 * common platform fonts PyCharm also lists. Order is the picker's display order.
 */
export const MONO_FAMILIES: readonly MonoFontFamily[] = [
  {
    id: "jetbrains-mono",
    family: "JetBrains Mono",
    label: "JetBrains Mono",
    bundled: true,
    ligatures: true,
    note: "PyCharm default",
  },
  { id: "fira-code", family: "Fira Code", label: "Fira Code", bundled: true, ligatures: true },
  {
    id: "cascadia-code",
    family: "Cascadia Code",
    label: "Cascadia Code",
    bundled: true,
    ligatures: true,
  },
  {
    id: "source-code-pro",
    family: "Source Code Pro",
    label: "Source Code Pro",
    bundled: true,
    ligatures: false,
  },
  {
    id: "ibm-plex-mono",
    family: "IBM Plex Mono",
    label: "IBM Plex Mono",
    bundled: true,
    ligatures: false,
  },
  {
    id: "roboto-mono",
    family: "Roboto Mono",
    label: "Roboto Mono",
    bundled: true,
    ligatures: false,
  },
  {
    id: "inconsolata",
    family: "Inconsolata",
    label: "Inconsolata",
    bundled: true,
    ligatures: false,
  },
  {
    id: "ubuntu-mono",
    family: "Ubuntu Mono",
    label: "Ubuntu Mono",
    bundled: true,
    ligatures: false,
  },
  // Platform monospace fonts PyCharm also offers — rendered only where installed.
  {
    id: "menlo",
    family: "Menlo",
    label: "Menlo (system)",
    bundled: false,
    ligatures: false,
    note: "macOS",
  },
  {
    id: "monaco",
    family: "Monaco",
    label: "Monaco (system)",
    bundled: false,
    ligatures: false,
    note: "macOS",
  },
  {
    id: "sf-mono",
    family: "SF Mono",
    label: "SF Mono (system)",
    bundled: false,
    ligatures: false,
    note: "macOS",
  },
  {
    id: "consolas",
    family: "Consolas",
    label: "Consolas (system)",
    bundled: false,
    ligatures: false,
    note: "Windows",
  },
  {
    id: "dejavu-sans-mono",
    family: "DejaVu Sans Mono",
    label: "DejaVu Sans Mono (system)",
    bundled: false,
    ligatures: false,
    note: "Linux",
  },
  {
    id: "courier-new",
    family: "Courier New",
    label: "Courier New (system)",
    bundled: false,
    ligatures: false,
  },
];

/** The default family id (PyCharm ships JetBrains Mono). */
export const DEFAULT_FONT_FAMILY_ID = "jetbrains-mono";

/** Look a family up by its persisted id. */
export function familyById(id: string): MonoFontFamily | undefined {
  return MONO_FAMILIES.find((f) => f.id === id);
}

/**
 * The full CSS font-family stack for a family id: the chosen family (quoted)
 * followed by the shared fallback tail. Falls back to the default family when the
 * id is unknown (e.g. a settings value from a newer build). Suitable for both a
 * CSS `font-family` and an xterm/Monaco `fontFamily` (a literal string, never a
 * `var()` — xterm's canvas does not resolve CSS custom properties).
 */
export function resolveFontStack(id: string): string {
  const fam = familyById(id) ?? familyById(DEFAULT_FONT_FAMILY_ID);
  const name = fam ? `"${fam.family}"` : "";
  return name ? `${name}, ${MONO_FALLBACK}` : MONO_FALLBACK;
}

/** Whether a family id supports programming ligatures (gates the toggle). */
export function familyHasLigatures(id: string): boolean {
  return familyById(id)?.ligatures ?? false;
}
