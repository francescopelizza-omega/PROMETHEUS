package com.prometheus.studio.jetbrains

/*
 * UNTESTED DRAFT — see README.md at the package root. Never compiled or run.
 *
 * The tool window's content: an embedded Chromium webview (JCEF, via JBCefBrowser)
 * hosting a small self-contained HTML/JS chat-log UI, bridged to the
 * `prometheus` CLI subprocess owned by PrometheusCliService. JCEF is the
 * standard IntelliJ Platform mechanism for hosting arbitrary web content inside
 * a Swing-based IDE (it backs, among other things, the platform's own bundled
 * Markdown preview and the JetBrains "What's New" panel), which is why it was
 * chosen here over a plain Swing/JTextArea console view for a chat-style panel.
 *
 * DESIGN NOTE (independent choice): a `studio/apps/vscode-extension` package
 * exists in this repo but, as of this draft, has no webview/chat-panel UI code
 * to read for visual consistency (only tool-runner.ts / workspace-io.ts) — and
 * more importantly it embeds `@prometheus/core` directly in-process (viable
 * because the VS Code extension host is a Node process), which is not the
 * mechanism this plugin uses (see PrometheusCliService.kt), so mirroring its
 * UI would not have mirrored an equivalent architecture anyway. Rather than
 * re-deriving a full xterm.js terminal emulator embedded in JCEF (the more
 * "faithful to a real TTY" option, and closer to what studio/apps/desktop's
 * own xterm-based terminal panes do), this draft renders a much simpler
 * append-only chat log: each line the CLI subprocess prints becomes one
 * entry, and a single input box sends a line back on stdin.
 * That's a deliberately smaller surface to get right in an unverifiable draft.
 * A human continuing this should decide whether to invest in a real terminal
 * emulator (xterm.js is MIT-licensed and would run fine inside the same JCEF
 * browser) once they can actually see the CLI's real output (ANSI codes,
 * spinners, etc. will currently render as raw escape sequences — see the CSS
 * `white-space: pre-wrap` in chat.css, which is the extent of the handling here).
 */

import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import java.awt.BorderLayout
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Swing panel wrapping a JBCefBrowser, shown as the "Prometheus" tool window's
 * content (see PrometheusToolWindowFactory).
 */
class PrometheusChatPanel(private val project: Project) : JPanel(BorderLayout()) {

    init {
        if (!JBCefApp.isSupported()) {
            // VERIFY: JCEF is normally bundled in every current JetBrains IDE
            // distribution, but `isSupported()` can still return false on some
            // headless/CI or minimal-runtime configurations. This fallback is
            // deliberately minimal (a label, no retry/settings link) — a real
            // implementation should offer a plain-console fallback view instead
            // of a dead end, so the plugin degrades rather than half-works.
            add(JLabel("Prometheus: JCEF (embedded browser) is not available in this IDE runtime."), BorderLayout.CENTER)
        } else {
            val service = project.getService(PrometheusCliService::class.java)

            // VERIFY: `JBCefBrowser()` no-arg constructor is the simplest
            // overload; other overloads accept an initial URL or an
            // `OSREnabled`/`JBCefClient` for more advanced setups. A no-arg
            // browser + a follow-up `loadHTML(...)` call is the pattern I'm most
            // confident is stable across recent platform versions.
            val browser = JBCefBrowser()

            // JBCefJSQuery is the platform's supported JS -> Kotlin bridge: JS
            // calls into a generated JS function, which round-trips (async) to
            // this handler. VERIFY: `JBCefJSQuery.create(...)` takes a
            // `JBCefBrowserBase`; confirm `JBCefBrowser` still satisfies that
            // parameter type (it implements JBCefBrowserBase as of the versions
            // I trained on) on whatever platform version this is actually built
            // against.
            val inputQuery = JBCefJSQuery.create(browser)
            inputQuery.addHandler { text ->
                service.sendInput(text)
                null // no synchronous JS-visible response needed
            }

            val html = buildHtml()
            browser.loadHTML(html)

            // Inject the JS-side bridge function once the page has loaded, wiring
            // the chat input box's submit handler to the JBCefJSQuery round-trip.
            // VERIFY: firing this immediately after loadHTML (rather than from a
            // load-completion callback such as a CefLoadHandler) races the
            // browser's own page load. A real implementation should hook
            // `JBCefClient`'s load handler and inject only once the page is
            // confirmed loaded, instead of assuming loadHTML's call returns after
            // the DOM is ready (it likely does not).
            browser.cefBrowser.executeJavaScript(
                """
                window.sendToPrometheus = function(text) {
                    ${inputQuery.inject("text")}
                };
                """.trimIndent(),
                browser.cefBrowser.url,
                0
            )

            service.addOutputListener { line ->
                // Subprocess output arrives on a background thread; JCEF's
                // executeJavaScript is documented as safe to call off the EDT,
                // but SwingUtilities.invokeLater is used here anyway to keep any
                // future Swing-side state changes (e.g. a status label) on the
                // EDT by construction, rather than relying on JCEF's own thread
                // safety guarantees alone.
                SwingUtilities.invokeLater {
                    browser.cefBrowser.executeJavaScript(
                        "window.appendOutput(${jsStringLiteral(line)});",
                        browser.cefBrowser.url,
                        0
                    )
                }
            }

            service.start()

            add(browser.component, BorderLayout.CENTER)
        }
    }

    /** Reads and inlines the bundled chat.html/css/js resources into one document. */
    private fun buildHtml(): String {
        val css = readResource("/webview/chat.css")
        val js = readResource("/webview/chat.js")
        val body = readResource("/webview/chat.html")
        return """
            <!DOCTYPE html>
            <html>
            <head>
            <meta charset="utf-8">
            <style>$css</style>
            </head>
            <body>
            $body
            <script>$js</script>
            </body>
            </html>
        """.trimIndent()
    }

    private fun readResource(path: String): String {
        val stream = javaClass.getResourceAsStream(path)
            ?: error("Prometheus plugin: missing bundled resource $path")
        return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    /** Escapes a Kotlin string as a JS double-quoted string literal. */
    private fun jsStringLiteral(text: String): String {
        val escaped = text
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "")
        return "\"$escaped\""
    }
}
