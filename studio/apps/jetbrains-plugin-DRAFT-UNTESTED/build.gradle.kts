// UNTESTED DRAFT — see README.md. Never resolved by Gradle, never compiled.
//
// DSL CHOICE: this file targets the OLDER, long-established
// `org.jetbrains.intellij` Gradle IntelliJ Plugin (the "1.x" plugin, published as
// `org.jetbrains.intellij` on the Gradle Plugin Portal), NOT the newer
// `org.jetbrains.intellij.platform` ("2.x" IntelliJ Platform Gradle Plugin).
//
// Why: the 2.x plugin restructured the DSL around a `dependencies { intellijPlatform
// { ... } }` block, a `intellijPlatformTesting` block, and version catalogs, and that
// exact shape changed more than once across its own pre-1.0/early releases. I do not
// have high enough confidence in the CURRENT exact syntax of that newer DSL to write
// it here without a way to compile-check it — guessing at it would be worse than
// using the older, stable API I'm confident about. The 1.x `intellij { }` extension
// block shown below has been stable and documented essentially unchanged for several
// years, which is why it's the safer bet for an unverifiable draft.
//
// A human picking this up should decide whether to migrate to the 2.x plugin (it is
// the one JetBrains is actively developing forward) — that migration is exactly the
// kind of change that needs a real Gradle + IDE round-trip to get right.

plugins {
    id("java")
    // VERIFY: pin to whatever current stable Kotlin release matches the target
    // IntelliJ Platform's bundled Kotlin (the platform and plugin Kotlin versions
    // must be source/binary compatible; mismatches show up as obscure metadata
    // version errors at IDE startup, not at compile time).
    kotlin("jvm") version "1.9.24"
    // VERIFY: 1.17.4 was a real published release of the Gradle IntelliJ Plugin
    // (1.x line) as of my training data; a newer 1.x patch release (or the 2.x
    // plugin, see note above) may exist now. Check
    // https://plugins.jetbrains.com/docs/intellij/tools-gradle-intellij-plugin.html
    id("org.jetbrains.intellij") version "1.17.4"
}

group = "com.prometheus.studio"
version = "0.1.0"

repositories {
    mavenCentral()
}

// The 1.x plugin's central configuration block: which IDE + which bundled/plugin
// dependencies to compile and run against.
intellij {
    // VERIFY: exact patch version. 2023.3 (build family 233) is the platform version
    // this draft targets for compilation; `type` selects the IntelliJ IDEA Community
    // Edition sandbox (cheapest to download/run for `runIde`, and sufficient because
    // this plugin only depends on com.intellij.modules.platform, not anything
    // IDEA-Ultimate- or language-plugin-specific).
    version.set("2023.3.6")
    type.set("IC") // IntelliJ IDEA Community Edition. Alternatives: "IU", "PY", "PC", "AI".

    // No bundled/plugin dependencies beyond the base platform — JCEF ships inside it.
    plugins.set(emptyList())
}

tasks {
    // Keeps the compiled bytecode + kotlinOptions aligned with what the target
    // platform's JBR (JetBrains Runtime) actually runs. IntelliJ 2023.3 bundles a
    // JBR on JDK 17, hence targeting 17 here (NOT the machine's arbitrary default).
    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }
    withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
        kotlinOptions.jvmTarget = "17"
    }

    // patchPluginXml injects since/until build overrides at build time if set here;
    // left to the static values already in plugin.xml (kept in ONE place) rather
    // than duplicated here.
    patchPluginXml {
        sinceBuild.set("233")
        untilBuild.set("253.*")
    }

    // `./gradlew runIde` launches a real sandboxed IDE instance with this plugin
    // installed — the primary way a human verifies any of this actually works.
    runIde {
        // VERIFY: JCEF requires the sandbox IDE to launch with a JBR build that
        // includes the bundled Chromium runtime. The 1.x plugin normally resolves
        // this automatically from the `version`/`type` above; if `runIde` starts
        // but the tool window's browser area is blank, check
        // `JBCefApp.isSupported()` first (see PrometheusChatPanel.kt).
    }

    buildSearchableOptions {
        // No dedicated Settings page in this draft (see README "Not included"),
        // so this indexing task has nothing to do. Left enabled (the platform
        // default) rather than disabled, since disabling it is only a build-speed
        // optimization and isn't needed to get a correct build.
    }
}
