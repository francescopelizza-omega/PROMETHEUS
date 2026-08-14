package com.prometheus.studio.jetbrains

/*
 * UNTESTED DRAFT — see README.md at the package root. Never compiled or run.
 *
 * THE MECHANISM (this is the class that owns it):
 *
 * This service shells out to the `prometheus` CLI binary as an OS subprocess,
 * launched with its working directory set to the currently open IntelliJ
 * project's root path (`project.basePath`). It does not attempt to embed the
 * Prometheus TypeScript core loop, the Python engine (`prometheus.py`), or the
 * `nemesis` security gate inside this JVM process — those are a separate,
 * independently-versioned runtime (Node + Python) that the CLI already knows how
 * to locate (PROMETHEUS_PY / NEMESIS_BIN env vars, sibling checkout, PATH — see
 * studio/apps/cli/README.md "The engine"). Reimplementing that resolution logic
 * here, or worse, vendoring a second copy of the engine inside the plugin, would
 * both duplicate real work and risk drifting out of sync with the actual gate.
 * Shelling out to the one binary the user already has installed keeps this
 * plugin a thin, honest client of the SAME engine the standalone CLI and the
 * desktop Studio app use — one gate, three surfaces, per the project's own
 * framing (see the root README's "It ships as three surfaces over one gated
 * engine").
 *
 * The CLI's bare interactive mode (`prometheus`, no subcommand, on a TTY) opens
 * a readline session; this service instead runs it as a plain (non-PTY) child
 * process wired to pipes, which is enough for a first draft that streams
 * stdout/stderr into the webview and forwards typed input back on stdin. A real
 * implementation likely wants a PTY (the CLI's own `studio/apps/cli/src/pty/`
 * exists for exactly this reason: some of its behavior — prompts, spinners,
 * ANSI cursor control — assumes a real terminal) but the JVM has no built-in PTY
 * support; that would mean either shipping a native library (e.g. pty4j, which
 * the JetBrains-maintained terminal plugin itself uses) or resigning this first
 * pass to the plain-pipe subset of CLI behavior. Documented here rather than
 * silently guessed at, since it materially affects fidelity: see the `// VERIFY`
 * / TODO below and the README's "What a human needs to do" section.
 */

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * Project-level service (registered as `<projectService>` in plugin.xml) that
 * owns one `prometheus` CLI child process per project.
 *
 * VERIFY: `@Service(Service.Level.PROJECT)` is the current (2021.3+) annotation
 * form for declaring a project service purely in Kotlin without needing the
 * matching XML `<projectService>` entry at all — plugin.xml here still declares
 * it explicitly for clarity/back-compat with slightly older platform versions,
 * but a human should confirm whether both are needed, or whether the annotation
 * alone now suffices and the XML entry is redundant/conflicting on their target
 * platform version.
 */
@Service(Service.Level.PROJECT)
class PrometheusCliService(private val project: Project) {

    private var process: Process? = null
    private var stdin: OutputStreamWriter? = null
    private val listeners = CopyOnWriteArrayList<(String) -> Unit>()

    // A single background thread pump per process; avoids blocking the EDT
    // (IntelliJ's UI thread) on subprocess I/O, which would freeze the whole IDE.
    private val ioExecutor = Executors.newCachedThreadPool()

    /** Registers a callback invoked (off the EDT) with each line of CLI output. */
    fun addOutputListener(listener: (String) -> Unit) {
        listeners.add(listener)
    }

    /**
     * Starts the `prometheus` subprocess against this project's root, if not
     * already running. Safe to call more than once; a no-op if already started.
     */
    fun start() {
        if (process?.isAlive == true) return

        val projectRoot = project.basePath
            ?: error("Prometheus plugin: project has no root path (basePath is null — a default/light project?)")

        // Resolution order mirrors the CLI's own documented lookup (README:
        // PATH first here, since a human who installed the CLI globally is the
        // common case for an IDE plugin; PROMETHEUS_PY/NEMESIS_BIN are the CLI's
        // own env vars for locating the ENGINE underneath it, not the CLI binary
        // itself, and are left to the user's existing shell/IDE environment
        // rather than re-resolved here).
        //
        // VERIFY: `ProcessBuilder` does not consult a login shell's PATH
        // modifications (.zshrc/.bash_profile) when the IDE itself was launched
        // from Finder/Dock rather than a terminal — this is a well-known IntelliJ
        // plugin gotcha for any "shell out to a CLI" plugin (the same problem
        // studio's own bin/prometheus launcher works around for its OWN PATH
        // lookup). A real implementation should probably resolve the binary via
        // the same fallback search bin/prometheus uses, or expose a Settings
        // field for an explicit path, rather than relying on ProcessBuilder's
        // inherited environment.
        val command = listOf("prometheus", "session")

        val builder = ProcessBuilder(command)
            .directory(java.io.File(projectRoot))
            .redirectErrorStream(true) // merge stderr into stdout for a single output stream

        process = builder.start()
        stdin = OutputStreamWriter(process!!.outputStream)

        ioExecutor.submit {
            val reader = BufferedReader(InputStreamReader(process!!.inputStream))
            try {
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    val text = line ?: continue
                    listeners.forEach { it(text) }
                }
            } catch (_: Exception) {
                // VERIFY: swallow-and-log is a placeholder; a real implementation
                // should surface process-death / IO errors into the tool window
                // itself rather than only to the IDE log, so the user isn't left
                // staring at a silently-frozen chat panel.
            }
        }
    }

    /** Writes a line of input to the CLI's stdin, as if the user typed it. */
    fun sendInput(text: String) {
        val writer = stdin ?: return
        writer.write(text)
        writer.write("\n")
        writer.flush()
    }

    fun stop() {
        process?.destroy()
        process = null
        stdin = null
    }

    // VERIFY: this service should implement `Disposable` (or rely on the
    // project-service-as-Disposable pattern some platform versions wire up
    // automatically) so `stop()` runs on project close rather than leaking a
    // child process per closed project. Not wired up in this draft — flagging
    // rather than guessing at the current disposal-registration idiom.
}
