/**
 * agent/permissions.ts — the remembered-permission surface, as one importable module.
 *
 * `ScopedPermissionStore` (the memory) and `withRememberedGrants` (the confirm wrapper that
 * reads it) are two files that are useless apart: a store nothing consults changes nothing, and
 * the wrapper needs a store. They were reachable only through core's ROOT barrel, which is
 * node-tainted — so the C5-sandboxed renderer could not import either, which is a large part of
 * why the desktop never had remembered grants at all.
 *
 * Both halves are PURE (the on-disk half is `system/host/grants-store.ts`), so this subpath is
 * safe for the renderer.
 */
export type { Grant, GrantScope } from "./scoped-permission.js";
export { ScopedPermissionStore, deriveSubject, isTooBroad } from "./scoped-permission.js";
export type { RememberedConfirmOptions } from "./remembered-confirm.js";
export { withRememberedGrants } from "./remembered-confirm.js";
