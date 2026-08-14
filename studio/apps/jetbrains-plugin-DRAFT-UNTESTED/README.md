UNTESTED DRAFT — written without any Java/Gradle/IntelliJ SDK available; has never been compiled or run. Verify on a machine with a JDK before relying on any of this.

# Prometheus Studio — JetBrains Plugin (draft)

An early, **unverified** draft of a JetBrains Platform plugin (targets IntelliJ
IDEA, WebStorm, PyCharm, Android Studio, and the rest of the standard JetBrains
IDE family via the `com.intellij.modules.platform` dependency) that brings a
Prometheus chat/agent tool window into the IDE.

This was written entirely from training knowledge, on a machine with **no Java
runtime and no Gradle** (`java -version` → "Unable to locate a Java Runtime";
`which gradle` → not found — reconfirmed at the start of this task). Nothing in
this directory has been compiled, resolved, launched, or tested in any way. Do
not treat any claim below about what "works" as verified — none of it is.

## Why this exists / the architectural choice

The plugin does **not** embed the Prometheus engine (`prometheus.py` + the
`nemesis` security gate) or the TypeScript CLI core inside the IDE's JVM
process — bundling a Python interpreter and a Node runtime into every IntelliJ
install isn't practical, and would mean re-deriving the CLI's own environment/
engine-resolution logic (`PROMETHEUS_PY` / `NEMESIS_BIN` / PATH lookup,
documented in `studio/apps/cli/README.md`) a second time, with a real risk of
drifting out of sync with the actual security gate.

Instead, the plugin **shells out to the already-installed `prometheus` CLI
binary** as a subprocess, launched with its working directory set to the
currently open IntelliJ project's root path, and renders that CLI session
inside an embedded Chromium webview (JCEF / `JBCefBrowser`) docked as a sidebar
tool window. This mirrors the project's own framing of itself as "three
surfaces over one gated engine" (desktop Studio app, `prometheus` CLI, and now
this IDE plugin) — the plugin adds a fourth surface without touching the gate.
This choice, and its trade-offs, is documented again as a code comment at the
top of `PrometheusCliService.kt` (the class that actually owns the subprocess).

A `studio/apps/vscode-extension` package (`prometheus-vscode`) appeared in this
workspace partway through writing this draft — it was not present when this
task started, and at the point it was checked here it contained only
`src/tool-runner.ts` and `src/workspace-io.ts` (no webview/chat-panel UI code
yet to read for visual consistency). What it does establish is that VS Code's
extension mirrors the mechanism, not the mechanism itself: it embeds
`@prometheus/core` **directly** in-process (its `package.json` bundles
`@prometheus/core` as a dependency and notes an esbuild step bridging that
package's ESM to the CJS the VS Code extension host loads). That's viable
there because the VS Code extension host is itself a Node process — the exact
thing this task's brief calls out as impractical for a JVM-hosted IntelliJ
plugin. So the two surfaces are intentionally **not** architecturally
parallel: VS Code embeds the TypeScript core loop directly; this plugin shells
out to the standalone `prometheus` CLI instead, for the reasons given above and
in `PrometheusCliService.kt`. The webview design here (a plain append-only
chat log, not a full terminal emulator) is an independent choice made without
a UI reference to mirror — see the comment block at the top of
`PrometheusChatPanel.kt` for the reasoning and what a fuller implementation
would likely add (a real xterm.js terminal inside the same JCEF browser, to
correctly render the CLI's ANSI output, spinners, etc., which currently show
up as raw escape sequences).

## What's included

```
jetbrains-plugin-DRAFT-UNTESTED/
├── README.md                       (this file)
├── build.gradle.kts                Gradle build, see DSL note below
├── settings.gradle.kts
├── gradle.properties
├── gradle/wrapper/
│   └── gradle-wrapper.properties   (the wrapper JAR itself is NOT included — see below)
└── src/main/
    ├── kotlin/com/prometheus/studio/jetbrains/
    │   ├── PrometheusToolWindowFactory.kt   registers the sidebar tool window
    │   ├── PrometheusChatPanel.kt           JCEF webview + JS bridge
    │   └── PrometheusCliService.kt          owns the `prometheus` CLI subprocess
    └── resources/
        ├── META-INF/plugin.xml             plugin manifest
        └── webview/
            ├── chat.html
            ├── chat.css
            └── chat.js
```

### Gradle DSL choice

`build.gradle.kts` uses the older, long-established **`org.jetbrains.intellij`**
Gradle IntelliJ Plugin (the "1.x" line), not the newer
**`org.jetbrains.intellij.platform`** ("2.x" IntelliJ Platform Gradle Plugin).
The 2.x plugin restructured its DSL substantially (a
`dependencies { intellijPlatform { ... } }` block, version catalogs, etc.), and
I do not have high enough confidence in its *exact current* syntax to write it
correctly with no way to compile-check it. The 1.x `intellij { }` extension
block used here has been stable and well-documented for years, making it the
safer choice for a draft nobody can verify yet. A human continuing this should
decide whether to migrate to the 2.x plugin (JetBrains' actively-developed
line) — do that migration on a machine that can actually build the project.

### What's NOT included

- **No Gradle wrapper jar.** `gradle/wrapper/gradle-wrapper.properties` is
  present (pins Gradle 8.7), but the binary `gradle-wrapper.jar` and the
  `gradlew`/`gradlew.bat` launcher scripts are not — generating a wrapper
  binary faithfully requires an actual Gradle install, which this environment
  doesn't have. Run `gradle wrapper --gradle-version 8.7` yourself once you
  have Gradle, or open the project directly in IntelliJ IDEA (which can
  provision the wrapper for you).
- **No plugin icon** (`pluginIcon.svg`) — `plugin.xml` references one that
  does not exist yet; add a 16x16/13x13 SVG or remove the `icon` attribute.
- **No Settings page**, no PTY-backed terminal (see `PrometheusCliService.kt`
  for why a plain-pipe subprocess was used instead of a PTY, and what a real
  terminal experience would need), no packaging/signing config beyond the
  bare `patchPluginXml` block, no CI.
- **No tests.** There is no headless IntelliJ Platform test harness set up
  here at all (that itself requires a JVM + the platform test framework this
  environment doesn't have).

## What a human needs to do to actually build/verify this

1. Install a **JDK 17+** (the IntelliJ Platform's bundled JBR for the 2023.3
   line targeted here runs on JDK 17; match whatever platform version you
   actually build against).
2. Install **Gradle** (or generate the wrapper: `gradle wrapper --gradle-version 8.7`,
   which will populate `gradle-wrapper.jar` and the `gradlew`/`gradlew.bat`
   scripts this draft deliberately left out — see above).
3. Open the `jetbrains-plugin-DRAFT-UNTESTED` directory as a Gradle project in
   IntelliJ IDEA (Community or Ultimate).
4. Run `./gradlew runIde` — this downloads the pinned IntelliJ Platform
   version (2023.3.6 Community, per `build.gradle.kts`) and launches a
   sandboxed IDE instance with this plugin installed. This is the actual
   verification step; nothing above this line has been exercised.
5. Confirm the "Prometheus" tool window appears on the right rail, that the
   JCEF webview renders (check `JBCefApp.isSupported()` if it doesn't — see
   the fallback path in `PrometheusChatPanel.kt`), and that typing into the
   input box actually reaches a `prometheus session` subprocess launched
   against an open project's root (requires `prometheus` to be resolvable —
   see the `ProcessBuilder`/PATH caveat documented in `PrometheusCliService.kt`).

## Honest list of what is NOT verified

- Whether `build.gradle.kts` resolves against real Maven Central / JetBrains
  Marketplace artifacts at all.
- Whether the exact Gradle IntelliJ Plugin (1.x) version pinned
  (`1.17.4`) still exists / is still the latest compatible 1.x release.
- Whether `plugin.xml`'s extension point names/attributes
  (`<toolWindow>`, `<projectService>`) are exactly correct for any specific
  current platform version — the shapes used are the ones I'm most confident
  in from training data, not confirmed against current SDK docs.
- Whether the Kotlin code compiles at all — API signatures for
  `ToolWindowFactory`, `ContentFactory.getInstance()`, `JBCefBrowser`,
  `JBCefJSQuery.create(...)`, and `@Service(Service.Level.PROJECT)` are used as
  I best recall them, each with an inline `// VERIFY:` comment where my
  confidence is lower than "very likely correct".
- Whether the tool window actually registers/renders at runtime.
- Whether the JCEF JS↔Kotlin bridge (`JBCefJSQuery`) actually round-trips
  correctly, or races the page load as flagged in `PrometheusChatPanel.kt`.
- Whether the `prometheus session` subprocess invocation is the right CLI
  invocation for this use case at all (vs. some other verb/flag combination) —
  chosen from reading `studio/apps/cli/README.md`, not from testing it.

This directory is intentionally isolated from the rest of the `studio` pnpm
workspace/monorepo (no `package.json`, so pnpm's `apps/*` workspace glob does
not pick it up; not referenced from the root `tsconfig.json` project-reference
graph; contains no `*.test.ts(x)` files for the root test runner to discover).
It should have zero effect on `pnpm run typecheck` / `pnpm run test` at the
studio root.
