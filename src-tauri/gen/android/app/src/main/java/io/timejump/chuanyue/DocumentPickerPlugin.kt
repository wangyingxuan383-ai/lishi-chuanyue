package io.timejump.chuanyue

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

internal const val DOCUMENT_PICK_TIMEOUT_MS = 180_000L
private const val RETURN_CALLBACK_GRACE_MS = 1_000L
private const val MAX_DOCUMENT_URI_CHARS = 8192

/** No path, initial URI, broad storage permission or persistent grant is requested. */
internal fun buildImportDocumentIntent(): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = "*/*"
    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
}

internal fun buildExportDocumentIntent(suggestedName: String): Intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = "text/plain"
    putExtra(Intent.EXTRA_TITLE, suggestedName)
    addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
}

internal fun documentPickerFailure(code: String): JSObject = JSObject()
    .put("status", "failed").put("code", code)

internal fun decodeDocumentPickerResult(result: ActivityResult): JSObject {
    if (result.resultCode == Activity.RESULT_CANCELED) {
        return JSObject().put("status", "cancelled")
    }
    if (result.resultCode != Activity.RESULT_OK) return documentPickerFailure("file_unavailable")
    // Deliberately do not inspect OEM extras, guess a filesystem path, or open I/O on UI.
    val intent = result.data ?: return documentPickerFailure("file_unavailable")
    val uri = intent.data ?: return documentPickerFailure("file_unavailable")
    val text = uri.toString()
    if (uri.scheme != "content" || uri.authority.isNullOrEmpty() ||
        text.length > MAX_DOCUMENT_URI_CHARS || text.any { Character.isISOControl(it) } ||
        (intent.clipData?.itemCount ?: 0) > 1) {
        return documentPickerFailure("file_unavailable")
    }
    return JSObject().put("status", "selected").put("uri", text)
}

/** Exactly one response, even after timeout, repeated callbacks or activity teardown. */
internal class DocumentPickerReplyGate(private val reply: (JSObject) -> Unit) {
    private var resolved = false
    var hasPaused = false
        private set

    fun paused() { hasPaused = true }

    fun finish(value: JSObject): Boolean {
        if (resolved) return false
        resolved = true
        reply(value)
        return true
    }

    fun timedOut() = finish(documentPickerFailure("file_unconfirmed"))

    fun returnedWithoutCallback(): Boolean {
        if (!hasPaused) return false
        return finish(documentPickerFailure("file_unconfirmed"))
    }
}

/** UI-thread-owned slot. An old result cannot release a later request's lease. */
internal class DocumentPickerRequestSlot<T : Any> {
    var current: T? = null
        private set

    fun acquire(request: T): Boolean {
        if (current != null) return false
        current = request
        return true
    }

    fun release(request: T): Boolean {
        if (current !== request) return false
        current = null
        return true
    }
}

/**
 * Native Rust PluginHandle only. The Rust plugin handler denies and handles the
 * entire namespace, including inherited commands, before mobile fallthrough.
 */
@TauriPlugin
class DocumentPickerPlugin(private val ownerActivity: Activity) : Plugin(ownerActivity) {
    private val handler = Handler(Looper.getMainLooper())
    private class Pending(val invoke: Invoke, val gate: DocumentPickerReplyGate) {
        lateinit var timeout: Runnable
    }
    private val requests = DocumentPickerRequestSlot<Pending>()
    private val pending: Pending? get() = requests.current

    private fun finish(current: Pending, value: JSObject) {
        if (pending !== current) return
        handler.removeCallbacks(current.timeout)
        requests.release(current)
        current.gate.finish(value)
    }

    @Command
    fun ensureIdle(invoke: Invoke) {
        handler.post {
            val reply = if (pending == null) JSObject().put("status", "idle")
                else documentPickerFailure("file_busy")
            invoke.resolve(reply)
        }
    }

    @Command
    fun openDocument(invoke: Invoke) {
        launchPicker(invoke, buildImportDocumentIntent())
    }

    @Command
    fun createDocument(invoke: Invoke) {
        val name = invoke.getArgs().optString("suggestedName", "export.txt")
        launchPicker(invoke, buildExportDocumentIntent(name))
    }

    private fun launchPicker(invoke: Invoke, intent: Intent) {
        handler.post {
            if (pending != null) {
                invoke.resolve(documentPickerFailure("file_busy"))
                return@post
            }
            try {
                if (ownerActivity.isFinishing || ownerActivity.isDestroyed) {
                    invoke.resolve(documentPickerFailure("file_unavailable"))
                    return@post
                }
                val current = Pending(invoke, DocumentPickerReplyGate { invoke.resolve(it) })
                current.timeout = Runnable {
                    if (pending === current) {
                        current.gate.timedOut()
                        // Keep quarantined until the old picker returns/destroys.
                        // Otherwise its late result could reach a newer Tauri callback.
                    }
                }
                if (!requests.acquire(current)) {
                    invoke.resolve(documentPickerFailure("file_busy"))
                    return@post
                }
                if (!handler.postDelayed(current.timeout, DOCUMENT_PICK_TIMEOUT_MS)) {
                    finish(current, documentPickerFailure("file_unavailable"))
                    return@post
                }
                try {
                    startActivityForResult(invoke, intent, "documentResult")
                } catch (_: Exception) {
                    finish(current, documentPickerFailure("file_unavailable"))
                }
            } catch (_: Exception) {
                // Never pass raw provider/exception details to Tauri reject/logging.
                invoke.resolve(documentPickerFailure("file_unavailable"))
            }
        }
    }

    @ActivityCallback
    fun documentResult(invoke: Invoke, result: ActivityResult) {
        handler.post {
            val current = pending ?: return@post
            if (current.invoke !== invoke) return@post
            val reply = try { decodeDocumentPickerResult(result) }
                catch (_: Exception) { documentPickerFailure("file_unavailable") }
            finish(current, reply)
        }
    }

    override fun onPause(activity: AppCompatActivity) {
        if (activity === ownerActivity) pending?.gate?.paused()
    }

    override fun onResume(activity: AppCompatActivity) {
        if (activity !== ownerActivity) return
        val current = pending ?: return
        if (!current.gate.hasPaused) return
        handler.postDelayed({
            if (pending === current) {
                // Normal Android activity results precede onResume. A small grace
                // also allows the already queued plugin result to run first.
                current.gate.returnedWithoutCallback()
                handler.removeCallbacks(current.timeout)
                requests.release(current)
            }
        }, RETURN_CALLBACK_GRACE_MS)
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (activity !== ownerActivity) return
        pending?.let { finish(it, documentPickerFailure("file_unconfirmed")) }
    }
}
