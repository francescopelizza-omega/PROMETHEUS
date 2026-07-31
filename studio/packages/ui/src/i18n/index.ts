/**
 * i18n/index.ts — the tiny message function (08 §7). ICU-lite `{param}`
 * substitution over the active catalog; NO runtime dependency (so node:test stays
 * green on stdlib). The default locale is `en`; a host can register more locales
 * via setLocale() once translations exist.
 *
 * GOLDEN RULE: copy lives in the catalog, never inline-concatenated in components,
 * so word order is translatable (08 §7 "no concatenated sentences").
 */

import { type MessageKey, en } from "./en.js";

export type { MessageKey } from "./en.js";
export { en } from "./en.js";

/** A locale catalog: every MessageKey → its template. */
export type Catalog = Record<MessageKey, string>;

const LOCALES: Record<string, Catalog> = { en };
let active: Catalog = en;
let activeTag = "en";

/** Register/replace a locale catalog and (optionally) make it active. */
export function registerLocale(tag: string, catalog: Catalog, makeActive = false): void {
  LOCALES[tag] = catalog;
  if (makeActive) {
    active = catalog;
    activeTag = tag;
  }
}

/** Switch the active locale; falls back to `en` for an unknown tag. */
export function setLocale(tag: string): void {
  active = LOCALES[tag] ?? en;
  activeTag = LOCALES[tag] ? tag : "en";
}

/** The active locale tag. */
export function locale(): string {
  return activeTag;
}

/**
 * Translate a key with ICU-lite `{param}` substitution. An unknown key returns the
 * key itself (loud, debuggable) rather than throwing. Params stringify; a missing
 * param leaves its placeholder so the gap is visible, never a silent "undefined".
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = active[key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
