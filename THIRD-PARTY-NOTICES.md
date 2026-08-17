# Third-party notices

PROMETHEUS itself is Apache-2.0 (see `LICENSE` and `NOTICE`). It redistributes the
components below. This file is GENERATED — run `node scripts/gen-third-party-notices.mjs`
after changing dependencies; do not edit it by hand.

**104 redistributed packages** (7 license identifiers), plus
545 build-time-only packages listed separately at the end. Attribution
obligations follow redistribution, so the distinction is kept explicit rather than merged.

| License | Redistributed |
|---|---:|
| MIT | 89 |
| OFL-1.1 | 8 |
| ISC | 3 |
| 0BSD | 1 |
| Apache-2.0 | 1 |
| BSD-3-Clause | 1 |
| UFL-1.0 | 1 |

## ℹ Unresolved licenses (build-time-only)

pnpm could not determine a license for the following. They are build tooling only and are never redistributed, so this does not block a release — but worth resolving.

- `spawndamnit@3.0.1`

## Python runtime (desktop app only)

The packaged desktop app bundles a relocatable CPython **3.12.6** (release
`20240909`) from [python-build-standalone](https://github.com/astral-sh/python-build-standalone), shipped as `extraResources`
under `Resources/pyruntime/`.

CPython is distributed under the **PSF License Agreement**; the standalone builds carry
the licenses of their own bundled components (OpenSSL, SQLite, libffi, ncurses, zlib and
others). The complete texts ship inside the runtime directory itself — see
`Resources/pyruntime/` in a packaged app, or `studio/staging/pyruntime/<os>-<arch>/` in a
build tree. The CLI does not bundle a runtime; it uses the system `python3`.

## Redistributed packages

### MIT

- `@floating-ui/core@1.7.5`
- `@floating-ui/dom@1.7.6`
- `@floating-ui/react-dom@2.1.8`
- `@floating-ui/utils@0.2.11`
- `@radix-ui/number@1.1.2`
- `@radix-ui/primitive@1.1.4`
- `@radix-ui/react-accordion@1.2.14`
- `@radix-ui/react-alert-dialog@1.1.17`
- `@radix-ui/react-arrow@1.1.10`
- `@radix-ui/react-avatar@1.2.0`
- `@radix-ui/react-checkbox@1.3.5`
- `@radix-ui/react-collapsible@1.1.14`
- `@radix-ui/react-collection@1.1.10`
- `@radix-ui/react-compose-refs@1.1.3`
- `@radix-ui/react-context@1.1.4`
- `@radix-ui/react-context-menu@2.3.1`
- `@radix-ui/react-dialog@1.1.17`
- `@radix-ui/react-direction@1.1.2`
- `@radix-ui/react-dismissable-layer@1.1.13`
- `@radix-ui/react-dropdown-menu@2.1.18`
- `@radix-ui/react-focus-guards@1.1.4`
- `@radix-ui/react-focus-scope@1.1.10`
- `@radix-ui/react-id@1.1.2`
- `@radix-ui/react-menu@2.1.18`
- `@radix-ui/react-popover@1.1.17`
- `@radix-ui/react-popper@1.3.1`
- `@radix-ui/react-portal@1.1.12`
- `@radix-ui/react-presence@1.1.6`
- `@radix-ui/react-primitive@2.1.6`
- `@radix-ui/react-progress@1.1.10`
- `@radix-ui/react-radio-group@1.4.1`
- `@radix-ui/react-roving-focus@1.1.13`
- `@radix-ui/react-scroll-area@1.2.12`
- `@radix-ui/react-select@2.3.1`
- `@radix-ui/react-separator@1.1.10`
- `@radix-ui/react-slider@1.4.1`
- `@radix-ui/react-slot@1.3.0`
- `@radix-ui/react-switch@1.3.1`
- `@radix-ui/react-tabs@1.1.15`
- `@radix-ui/react-toast@1.2.17`
- `@radix-ui/react-tooltip@1.2.10`
- `@radix-ui/react-use-callback-ref@1.1.2`
- `@radix-ui/react-use-controllable-state@1.2.3`
- `@radix-ui/react-use-effect-event@0.0.3`
- `@radix-ui/react-use-escape-keydown@1.1.2`
- `@radix-ui/react-use-is-hydrated@0.1.1`
- `@radix-ui/react-use-layout-effect@1.1.2`
- `@radix-ui/react-use-previous@1.1.2`
- `@radix-ui/react-use-rect@1.1.2`
- `@radix-ui/react-use-size@1.1.2`
- `@radix-ui/react-visually-hidden@1.2.6`
- `@radix-ui/rect@1.1.2`
- `@tanstack/query-core@5.101.0`
- `@tanstack/react-query@5.101.0`
- `@types/react@19.2.17`
- `@types/react-dom@19.2.3`
- `@xterm/addon-clipboard@0.1.0`
- `@xterm/addon-fit@0.10.0`
- `@xterm/addon-ligatures@0.10.0`
- `@xterm/xterm@5.5.0`
- `aria-hidden@1.2.6`
- `chokidar@4.0.3`
- `clsx@2.1.1`
- `cmdk@1.1.1`
- `csstype@3.2.3`
- `detect-node-es@1.1.0`
- `font-finder@1.1.0`
- `font-ligatures@1.4.1`
- `get-nonce@1.0.1`
- `get-system-fonts@2.0.2`
- `monaco-editor@0.52.2`
- `node-addon-api@7.1.1`
- `node-pty@1.1.0`
- `opentype.js@0.8.0`
- `promise-stream-reader@1.0.1`
- `react@19.2.7`
- `react-dom@19.2.7`
- `react-remove-scroll@2.7.2`
- `react-remove-scroll-bar@2.3.8`
- `react-style-singleton@2.2.3`
- `readdirp@4.1.2`
- `scheduler@0.27.0`
- `tailwind-merge@2.6.1`
- `tiny-inflate@1.0.3`
- `use-callback-ref@1.3.3`
- `use-sidecar@1.1.3`
- `vite-plugin-monaco-editor@1.1.0`
- `zod@3.25.76`
- `zustand@5.0.14`

### OFL-1.1

- `@fontsource/cascadia-code@5.2.3`
- `@fontsource/fira-code@5.2.7`
- `@fontsource/ibm-plex-mono@5.2.7`
- `@fontsource/inconsolata@5.2.8`
- `@fontsource/jetbrains-mono@5.2.8`
- `@fontsource/montserrat@5.2.8`
- `@fontsource/roboto-mono@5.2.9`
- `@fontsource/source-code-pro@5.2.7`

### ISC

- `lru-cache@6.0.0`
- `lucide-react@0.460.0`
- `yallist@4.0.0`

### 0BSD

- `tslib@2.8.1`

### Apache-2.0

- `class-variance-authority@0.7.1`

### BSD-3-Clause

- `js-base64@3.8.0`

### UFL-1.0

- `@fontsource/ubuntu-mono@5.2.8`

## Build-time only (not redistributed)

Toolchain used to produce the release — linters, bundlers, test runners, packagers.
Listed for completeness; none of it reaches a user's machine.

### MIT

- `@alcalzone/ansi-tokenize@0.1.3`
- `@alloc/quick-lru@5.2.0`
- `@babel/code-frame@7.29.7`
- `@babel/compat-data@7.29.7`
- `@babel/core@7.29.7`
- `@babel/generator@7.29.7`
- `@babel/helper-compilation-targets@7.29.7`
- `@babel/helper-globals@7.29.7`
- `@babel/helper-module-imports@7.29.7`
- `@babel/helper-module-transforms@7.29.7`
- `@babel/helper-plugin-utils@7.29.7`
- `@babel/helper-string-parser@7.29.7`
- `@babel/helper-validator-identifier@7.29.7`
- `@babel/helper-validator-option@7.29.7`
- `@babel/helpers@7.29.7`
- `@babel/parser@7.29.7`
- `@babel/plugin-transform-arrow-functions@7.29.7`
- `@babel/plugin-transform-react-jsx-self@7.29.7`
- `@babel/plugin-transform-react-jsx-source@7.29.7`
- `@babel/runtime@7.29.7`
- `@babel/template@7.29.7`
- `@babel/traverse@7.29.7`
- `@babel/types@7.29.7`
- `@changesets/apply-release-plan@7.1.1`
- `@changesets/assemble-release-plan@6.0.10`
- `@changesets/changelog-git@0.2.1`
- `@changesets/cli@2.31.0`
- `@changesets/config@3.1.4`
- `@changesets/errors@0.2.0`
- `@changesets/get-dependents-graph@2.1.4`
- `@changesets/get-release-plan@4.0.16`
- `@changesets/get-version-range-type@0.4.0`
- `@changesets/git@3.0.4`
- `@changesets/logger@0.1.1`
- `@changesets/parse@0.4.3`
- `@changesets/pre@2.0.2`
- `@changesets/read@0.6.7`
- `@changesets/should-skip-package@0.1.2`
- `@changesets/types@4.1.0, 6.1.0`
- `@changesets/write@0.4.0`
- `@develar/schema-utils@2.6.5`
- `@electron/asar@3.4.1`
- `@electron/get@2.0.3`
- `@electron/notarize@2.5.0`
- `@electron/rebuild@3.6.1`
- `@electron/universal@2.0.1`
- `@esbuild/darwin-arm64@0.21.5`
- `@gar/promisify@1.1.3`
- `@inquirer/external-editor@1.0.3`
- `@jridgewell/gen-mapping@0.3.13`
- `@jridgewell/remapping@2.3.5`
- `@jridgewell/resolve-uri@3.1.2`
- `@jridgewell/sourcemap-codec@1.5.5`
- `@jridgewell/trace-mapping@0.3.31`
- `@malept/flatpak-bundler@0.4.0`
- `@manypkg/find-root@1.1.0`
- `@manypkg/get-packages@1.1.3`
- `@nodelib/fs.scandir@2.1.5`
- `@nodelib/fs.stat@2.0.5`
- `@nodelib/fs.walk@1.2.8`
- `@npmcli/move-file@2.0.1`
- `@pkgjs/parseargs@0.11.0`
- `@rolldown/pluginutils@1.0.0-beta.27`
- `@rollup/rollup-darwin-arm64@4.62.0`
- `@sindresorhus/is@4.6.0`
- `@szmarczak/http-timer@4.0.6`
- `@tootallnate/once@2.0.1`
- `@turbo/darwin-arm64@2.9.18`
- `@types/babel__core@7.20.5`
- `@types/babel__generator@7.27.0`
- `@types/babel__template@7.4.4`
- `@types/babel__traverse@7.28.0`
- `@types/cacheable-request@6.0.3`
- `@types/debug@4.1.13`
- `@types/estree@1.0.9`
- `@types/fs-extra@9.0.13`
- `@types/http-cache-semantics@4.2.0`
- `@types/keyv@3.1.4`
- `@types/ms@2.1.0`
- `@types/node@12.20.55, 20.19.43`
- `@types/plist@3.0.5`
- `@types/prop-types@15.7.15`
- `@types/responselike@1.0.3`
- `@types/verror@1.10.11`
- `@types/yargs@17.0.35`
- `@types/yargs-parser@21.0.3`
- `@types/yauzl@2.10.3`
- `@vitejs/plugin-react@4.7.0`
- `@vitest/expect@2.1.9`
- `@vitest/mocker@2.1.9`
- `@vitest/pretty-format@2.1.9`
- `@vitest/runner@2.1.9`
- `@vitest/snapshot@2.1.9`
- `@vitest/spy@2.1.9`
- `@vitest/utils@2.1.9`
- `@xmldom/xmldom@0.9.10`
- `7zip-bin@5.2.0`
- `agent-base@6.0.2, 7.1.4`
- `agentkeepalive@4.6.0`
- `aggregate-error@3.1.0`
- `ajv@6.15.0`
- `ajv-keywords@3.5.2`
- `ansi-colors@4.1.3`
- `ansi-escapes@7.3.0`
- `ansi-regex@5.0.1, 6.2.2`
- `ansi-styles@4.3.0, 6.2.3`
- `any-promise@1.3.0`
- `app-builder-bin@5.0.0-alpha.10`
- `app-builder-lib@25.1.8`
- `archiver@5.3.2`
- `archiver-utils@2.1.0, 3.0.4`
- `arg@5.0.2`
- `argparse@1.0.10`
- `array-union@2.1.0`
- `assert-plus@1.0.0`
- `assertion-error@2.0.1`
- `astral-regex@2.0.0`
- `async@3.2.6`
- `async-exit-hook@2.0.1`
- `asynckit@0.4.0`
- `auto-bind@5.0.1`
- `autoprefixer@10.5.0`
- `balanced-match@1.0.2, 4.0.4`
- `base64-js@1.5.1`
- `better-path-resolve@1.0.0`
- `binary-extensions@2.3.0`
- `bl@4.1.0`
- `bluebird@3.7.2`
- `bluebird-lst@1.0.9`
- `boolean@3.2.0`
- `brace-expansion@1.1.15, 2.1.1, 5.0.7`
- `braces@3.0.3`
- `browserslist@4.28.2`
- `buffer@5.7.1`
- `buffer-crc32@0.2.13`
- `buffer-from@1.1.2`
- `builder-util@25.1.7`
- `builder-util-runtime@9.2.10`
- `cac@6.7.14`
- `cacheable-lookup@5.0.4`
- `cacheable-request@7.0.4`
- `call-bind-apply-helpers@1.0.2`
- `camelcase-css@2.0.1`
- `chai@5.3.3`
- `chalk@4.1.2, 5.6.2`
- `chardet@2.1.1`
- `check-error@2.1.3`
- `chromium-pickle-js@0.2.0`
- `ci-info@3.9.0`
- `clean-stack@2.2.0`
- `cli-boxes@3.0.0`
- `cli-cursor@3.1.0, 4.0.0`
- `cli-spinners@2.9.2`
- `cli-truncate@2.1.0, 4.0.0`
- `clone@1.0.4`
- `clone-response@1.0.3`
- `code-excerpt@4.0.0`
- `color-convert@2.0.1`
- `color-name@1.1.4`
- `combined-stream@1.0.8`
- `commander@4.1.1, 5.1.0, 9.5.0`
- `compare-version@0.1.2`
- `compress-commons@4.1.2`
- `concat-map@0.0.1`
- `config-file-ts@0.2.8-rc1`
- `convert-source-map@2.0.0`
- `convert-to-spaces@2.0.1`
- `core-util-is@1.0.2, 1.0.3`
- `crc@3.8.0`
- `crc32-stream@4.0.3`
- `cross-spawn@7.0.6`
- `cssesc@3.0.0`
- `debug@4.4.3`
- `decompress-response@6.0.0`
- `deep-eql@5.0.2`
- `defaults@1.0.4`
- `defer-to-connect@2.0.1`
- `define-data-property@1.1.4`
- `define-properties@1.2.1`
- `delayed-stream@1.0.0`
- `delegates@1.0.0`
- `detect-indent@6.1.0`
- `detect-node@2.1.0`
- `dir-compare@4.2.0`
- `dir-glob@3.0.1`
- `dlv@1.1.3`
- `dmg-builder@25.1.8`
- `dmg-license@1.0.11`
- `dunder-proto@1.0.1`
- `eastasianwidth@0.2.0`
- `electron@33.4.11`
- `electron-builder@25.1.8`
- `electron-builder-squirrel-windows@25.1.8`
- `electron-publish@25.1.7`
- `electron-vite@2.3.0`
- `emoji-regex@8.0.0, 9.2.2, 10.6.0`
- `encoding@0.1.13`
- `end-of-stream@1.4.5`
- `enquirer@2.4.1`
- `env-paths@2.2.1`
- `environment@1.1.0`
- `err-code@2.0.3`
- `es-define-property@1.0.1`
- `es-errors@1.3.0`
- `es-module-lexer@1.7.0`
- `es-object-atoms@1.1.2`
- `es-set-tostringtag@2.1.0`
- `es-toolkit@1.49.0`
- `es6-error@4.1.1`
- `esbuild@0.21.5`
- `escalade@3.2.0`
- `escape-string-regexp@2.0.0, 4.0.0`
- `estree-walker@3.0.3`
- `extendable-error@0.1.7`
- `extsprintf@1.4.1`
- `fast-deep-equal@3.1.3`
- `fast-glob@3.3.3`
- `fast-json-stable-stringify@2.1.0`
- `fd-slicer@1.1.0`
- `fdir@6.5.0`
- `figures@6.1.0`
- `fill-range@7.1.1`
- `find-up@4.1.0`
- `form-data@4.0.6`
- `fraction.js@5.3.4`
- `fs-constants@1.0.0`
- `fs-extra@7.0.1, 8.1.0, 9.1.0, 10.1.0, 11.3.6`
- `fsevents@2.3.2, 2.3.3`
- `function-bind@1.1.2`
- `gensync@1.0.0-beta.2`
- `get-east-asian-width@1.6.0`
- `get-intrinsic@1.3.0`
- `get-proto@1.0.1`
- `get-stream@5.2.0`
- `globalthis@1.0.4`
- `globby@11.1.0`
- `gopd@1.2.0`
- `got@11.8.6`
- `has-flag@4.0.0`
- `has-property-descriptors@1.0.2`
- `has-symbols@1.1.0`
- `has-tostringtag@1.0.2`
- `hasown@2.0.4`
- `http-proxy-agent@5.0.0, 7.0.2`
- `http2-wrapper@1.0.3`
- `https-proxy-agent@5.0.1, 7.0.6`
- `human-id@4.2.0`
- `humanize-ms@1.2.1`
- `iconv-corefoundation@1.1.7`
- `iconv-lite@0.6.3, 0.7.2`
- `ignore@5.3.2`
- `imurmurhash@0.1.4`
- `indent-string@4.0.0, 5.0.0`
- `ink@5.2.1`
- `ink-select-input@6.2.0`
- `ink-spinner@5.0.0`
- `ip-address@10.2.0`
- `is-binary-path@2.1.0`
- `is-ci@3.0.1`
- `is-core-module@2.16.2`
- `is-extglob@2.1.1`
- `is-fullwidth-code-point@3.0.0, 4.0.0, 5.1.0`
- `is-glob@4.0.3`
- `is-in-ci@1.0.0`
- `is-interactive@1.0.0`
- `is-lambda@1.0.1`
- `is-number@7.0.0`
- `is-subdir@1.2.0`
- `is-unicode-supported@0.1.0, 2.1.0`
- `is-windows@1.0.2`
- `isarray@1.0.0`
- `isbinaryfile@4.0.10, 5.0.7`
- `jiti@1.21.7`
- `js-tokens@4.0.0`
- `js-yaml@3.14.2, 4.2.0`
- `jsesc@3.1.0`
- `json-buffer@3.0.1`
- `json-schema-traverse@0.4.1`
- `json5@2.2.3`
- `jsonfile@4.0.0, 6.2.1`
- `keyv@4.5.4`
- `lazy-val@1.0.5`
- `lazystream@1.0.1`
- `lefthook@1.13.6`
- `lefthook-darwin-arm64@1.13.6`
- `lilconfig@3.1.3`
- `lines-and-columns@1.2.4`
- `locate-path@5.0.0`
- `lodash@4.18.1`
- `lodash.defaults@4.2.0`
- `lodash.difference@4.5.0`
- `lodash.flatten@4.4.0`
- `lodash.isplainobject@4.0.6`
- `lodash.startcase@4.4.0`
- `lodash.union@4.6.0`
- `log-symbols@4.1.0`
- `loose-envify@1.4.0`
- `loupe@3.2.1`
- `lowercase-keys@2.0.0`
- `magic-string@0.30.21`
- `matcher@3.0.0`
- `math-intrinsics@1.1.0`
- `merge2@1.4.1`
- `micromatch@4.0.8`
- `mime@2.6.0`
- `mime-db@1.52.0`
- `mime-types@2.1.35`
- `mimic-fn@2.1.0`
- `mimic-response@1.0.1, 3.1.0`
- `minimist@1.2.8`
- `minipass-fetch@2.1.2`
- `minizlib@2.1.2`
- `mkdirp@1.0.4`
- `mri@1.2.0`
- `ms@2.1.3`
- `mz@2.7.0`
- `nanoid@3.3.12`
- `negotiator@0.6.4`
- `node-abi@3.92.0`
- `node-api-version@0.2.1`
- `node-gyp@9.4.1`
- `node-releases@2.0.47`
- `normalize-path@3.0.0`
- `normalize-url@6.1.0`
- `object-assign@4.1.1`
- `object-hash@3.0.0`
- `object-keys@1.1.1`
- `onetime@5.1.2`
- `ora@5.4.1`
- `outdent@0.5.0`
- `p-cancelable@2.1.1`
- `p-filter@2.1.0`
- `p-limit@2.3.0, 3.1.0`
- `p-locate@4.1.0`
- `p-map@2.1.0, 4.0.0`
- `p-try@2.2.0`
- `package-manager-detector@0.2.11`
- `patch-console@2.0.0`
- `path-exists@4.0.0`
- `path-is-absolute@1.0.1`
- `path-key@3.1.1`
- `path-parse@1.0.7`
- `path-type@4.0.0`
- `pathe@1.1.2`
- `pathval@2.0.1`
- `pe-library@0.4.1`
- `pend@1.2.0`
- `picomatch@2.3.2, 4.0.4`
- `pify@2.3.0, 4.0.1`
- `pirates@4.0.7`
- `plist@3.1.1`
- `postcss@8.5.15`
- `postcss-import@15.1.0`
- `postcss-js@4.1.0`
- `postcss-load-config@6.0.1`
- `postcss-nested@6.2.0`
- `postcss-selector-parser@6.1.4`
- `postcss-value-parser@4.2.0`
- `postject@1.0.0-alpha.6`
- `prettier@2.8.8`
- `process-nextick-args@2.0.1`
- `progress@2.0.3`
- `promise-retry@2.0.1`
- `pump@3.0.4`
- `punycode@2.3.1`
- `quansync@0.2.11`
- `queue-microtask@1.2.3`
- `quick-lru@5.1.1`
- `react-reconciler@0.29.2`
- `react-refresh@0.17.0`
- `read-binary-file-arch@1.0.6`
- `read-cache@1.0.0`
- `read-yaml-file@1.1.0`
- `readable-stream@2.3.8, 3.6.2`
- `require-directory@2.1.1`
- `resedit@1.7.2`
- `resolve@1.22.12`
- `resolve-alpn@1.2.1`
- `resolve-from@5.0.0`
- `responselike@2.0.1`
- `restore-cursor@3.1.0, 4.0.0`
- `retry@0.12.0`
- `reusify@1.1.0`
- `rollup@4.62.0`
- `run-parallel@1.2.0`
- `safe-buffer@5.1.2, 5.2.1`
- `safer-buffer@2.1.2`
- `semver-compare@1.0.0`
- `serialize-error@7.0.1`
- `shebang-command@2.0.0`
- `shebang-regex@3.0.0`
- `simple-update-notifier@2.0.0`
- `slash@3.0.0`
- `slice-ansi@3.0.0, 5.0.0, 7.1.2`
- `smart-buffer@4.2.0`
- `socks@2.8.9`
- `socks-proxy-agent@7.0.0`
- `source-map-support@0.5.21`
- `stack-utils@2.0.6`
- `stackback@0.0.2`
- `stat-mode@1.0.0`
- `std-env@3.10.0`
- `string_decoder@1.1.1, 1.3.0`
- `string-width@4.2.3, 5.1.2, 7.2.0`
- `strip-ansi@6.0.1, 7.2.0`
- `strip-bom@3.0.0`
- `sucrase@3.35.1`
- `supports-color@7.2.0`
- `supports-preserve-symlinks-flag@1.0.0`
- `tailwindcss@3.4.19`
- `tar-stream@2.2.0`
- `temp-file@3.4.0`
- `term-size@2.2.1`
- `thenify@3.3.1`
- `thenify-all@1.6.0`
- `tinybench@2.9.0`
- `tinyexec@0.3.2`
- `tinyglobby@0.2.17`
- `tinypool@1.1.1`
- `tinyrainbow@1.2.0`
- `tinyspy@3.0.2`
- `tmp@0.2.7`
- `tmp-promise@3.0.3`
- `to-regex-range@5.0.1`
- `to-rotated@1.0.0`
- `turbo@2.9.18`
- `undici-types@6.21.0`
- `universalify@0.1.2, 2.0.1`
- `update-browserslist-db@1.2.3`
- `util-deprecate@1.0.2`
- `verror@1.10.1`
- `vite@5.4.21`
- `vite-node@2.1.9`
- `vitest@2.1.9`
- `wcwidth@1.0.1`
- `why-is-node-running@2.3.0`
- `widest-line@5.0.0`
- `wrap-ansi@7.0.0, 8.1.0, 9.0.2`
- `ws@8.21.0`
- `xmlbuilder@15.1.1`
- `yargs@17.7.3`
- `yauzl@2.10.0`
- `yocto-queue@0.1.0`
- `yoga-layout@3.2.1`
- `zip-stream@4.1.1`

### ISC

- `@isaacs/cliui@8.0.2`
- `@npmcli/fs@2.1.2`
- `abbrev@1.1.1`
- `anymatch@3.1.3`
- `aproba@2.1.0`
- `are-we-there-yet@3.0.1`
- `at-least-node@1.0.0`
- `cacache@16.1.3`
- `chownr@2.0.0`
- `cliui@8.0.1`
- `color-support@1.1.3`
- `console-control-strings@1.1.0`
- `electron-to-chromium@1.5.373`
- `fastq@1.20.1`
- `foreground-child@3.3.1`
- `fs-minipass@2.1.0`
- `fs.realpath@1.0.0`
- `gauge@4.0.4`
- `get-caller-file@2.0.5`
- `glob@7.2.3, 8.1.0, 10.5.0`
- `glob-parent@5.1.2, 6.0.2`
- `graceful-fs@4.2.11`
- `has-unicode@2.0.1`
- `hosted-git-info@4.1.0`
- `infer-owner@1.0.4`
- `inflight@1.0.6`
- `inherits@2.0.4`
- `isexe@2.0.0`
- `json-stringify-safe@5.0.1`
- `make-fetch-happen@10.2.1`
- `minimatch@3.1.5, 5.1.9, 9.0.9`
- `minipass@3.3.6, 5.0.0`
- `minipass-collect@1.0.2`
- `minipass-pipeline@1.2.4`
- `minipass-sized@1.0.3`
- `nopt@6.0.0`
- `npmlog@6.0.2`
- `once@1.4.0`
- `picocolors@1.1.1`
- `promise-inflight@1.0.1`
- `rimraf@3.0.2`
- `semver@6.3.1, 7.8.4`
- `set-blocking@2.0.0`
- `siginfo@2.0.0`
- `signal-exit@3.0.7, 4.1.0`
- `ssri@9.0.1`
- `tar@6.2.1`
- `unique-filename@2.0.1`
- `unique-slug@3.0.0`
- `which@2.0.2`
- `wide-align@1.1.5`
- `wrappy@1.0.2`
- `y18n@5.0.8`
- `yargs-parser@21.1.1`

### Apache-2.0

- `@malept/cross-spawn-promise@2.0.0`
- `@playwright/test@1.61.1`
- `baseline-browser-mapping@2.10.37`
- `crc-32@1.2.2`
- `detect-libc@2.1.2`
- `didyoumean@1.2.2`
- `ejs@3.1.10`
- `expect-type@1.3.0`
- `exponential-backoff@3.1.3`
- `filelist@1.0.6`
- `jake@10.9.4`
- `playwright@1.61.1`
- `playwright-core@1.61.1`
- `readdir-glob@1.1.3`
- `sumchecker@3.0.1`
- `ts-interface-checker@0.1.13`
- `typescript@5.9.3`

### BlueOak-1.0.0

- `jackspeak@3.4.3`
- `minimatch@10.2.5`
- `minipass@7.1.3`
- `minipass-flush@1.0.7`
- `package-json-from-dist@1.0.1`
- `path-scurry@1.11.1`
- `sax@1.6.0`

### BSD-2-Clause

- `@electron/osx-sign@1.3.1`
- `dotenv@16.6.1`
- `dotenv-expand@11.0.7`
- `esprima@4.0.1`
- `extract-zip@2.0.1`
- `http-cache-semantics@4.2.0`
- `uri-js@4.4.1`

### BSD-3-Clause

- `global-agent@3.0.0`
- `ieee754@1.2.1`
- `roarr@2.15.4`
- `source-map@0.6.1`
- `source-map-js@1.2.1`
- `sprintf-js@1.0.3, 1.1.3`

### MIT OR Apache-2.0

- `@biomejs/biome@1.9.4`
- `@biomejs/cli-darwin-arm64@1.9.4`

### (MIT OR CC0-1.0)

- `type-fest@0.13.1, 4.41.0`

### (WTFPL OR MIT)

- `utf8-byte-length@1.0.5`

### CC-BY-4.0

- `caniuse-lite@1.0.30001799`

### Python-2.0

- `argparse@2.0.1`

### WTFPL

- `truncate-utf8-bytes@1.0.2`

### WTFPL OR ISC

- `sanitize-filename@1.6.4`

