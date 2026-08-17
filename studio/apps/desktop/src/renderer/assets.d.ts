/**
 * assets.d.ts — ambient module declarations for non-code renderer assets.
 *
 * The renderer's single stylesheet (styles/global.css) is a side-effect import in
 * main.tsx (file 08 §6); electron-vite bundles it, but `tsc` needs an ambient
 * `*.css` module so the type-check accepts the import. This declares the asset
 * shapes the renderer imports (CSS + common static assets), nothing runtime.
 */

declare module "*.css";
// Image assets resolve to a bundler-fingerprinted URL. Typed as `string` (not the
// implicit `any` a bare `declare module` gives) so a misuse is a type error.
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.png" {
  const src: string;
  export default src;
}
