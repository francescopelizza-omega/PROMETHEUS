package com.prometheus.studio.jetbrains

/*
 * UNTESTED DRAFT — see README.md at the package root. Written with no JDK/Gradle/
 * IntelliJ Platform SDK available to compile or run it against; treat every API
 * call below as "believed correct from training knowledge", not verified.
 *
 * ARCHITECTURE (see also PrometheusCliService.kt, which owns the actual mechanism):
 * this plugin does NOT embed the Prometheus engine (prometheus.py + nemesis) or the
 * TypeScript CLI core inside the IDE's JVM process. Doing that would mean bundling
 * a Python interpreter and a Node runtime inside every IntelliJ install, duplicating
 * work the standalone `prometheus` CLI already does, and losing the CLI's own
 * fail-closed security gate as the single source of truth for verdicts (the
 * Prometheus "GOLDEN RULE": a UI surface never decides safety itself, it only
 * renders the verdict the engine produced). Instead this tool window shells out to
 * the `prometheus` binary as a child process, scoped to the currently open
 * project's root directory, and renders its session in an embedded webview.
 */

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/**
 * Registers and populates the "Prometheus" sidebar tool window (see the
 * `<toolWindow>` extension point in plugin.xml, which points here via
 * `factoryClass`).
 *
 * VERIFY: the `ToolWindowFactory` interface signature (`createToolWindowContent`,
 * and whether an `init(toolWindow: ToolWindow)` override or a `shouldBeAvailable`
 * override is also expected/recommended on the platform version a human actually
 * targets) has had minor additions across platform releases. Check the current
 * `com.intellij.openapi.wm.ToolWindowFactory` source/docs before relying on this
 * being the complete override set.
 */
class PrometheusToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = PrometheusChatPanel(project)

        // VERIFY: `ContentFactory.getInstance()` is the current (post-2020ish)
        // static accessor; some older code samples still floating around use
        // `ContentFactory.SERVICE.getInstance()`. Confirm which is current for the
        // targeted platform version — using a removed accessor would fail at
        // classload time, not compile time, in a plugin built against a mismatched
        // platform jar.
        val contentFactory = ContentFactory.getInstance()
        val content = contentFactory.createContent(panel, /* displayName = */ "", /* isLockable = */ false)

        toolWindow.contentManager.addContent(content)
    }

    // VERIFY: newer platform versions favor declaring `dumbAware`/availability via
    // plugin.xml attributes over an overridden `isApplicable`/`shouldBeAvailable`
    // method; left out here rather than guess at a method name I'm not certain is
    // still current.
}
