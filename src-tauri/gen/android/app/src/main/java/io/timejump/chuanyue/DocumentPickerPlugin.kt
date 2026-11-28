package io.timejump.chuanyue

import android.app.Activity
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
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
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

internal const val DOCUMENT_PICK_TIMEOUT_MS = 180_000L
internal const val RETURN_CALLBACK_GRACE_MS = 1_000L
internal const val RETURN_FOCUS_RETRY_MS = 1_500L
private const val MAX_DOCUMENT_URI_CHARS = 8192
internal val nextPickerRequestToken = AtomicLong(0L)

/** No path, initial URI, broad storage permission or persistent grant is requested. */
internal fun buildImportDocumentIntent(): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = "*/*"
    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
}

/** World archives (`.json`) are JSON, so file managers keep the name instead of adding `.txt`. */
internal fun exportMimeType(suggestedName: String): String =
    if (suggestedName.endsWith(".json", ignoreCase = true)) "application/json" else "text/plain"

internal fun buildExportDocumentIntent(suggestedName: String): Intent {
    val fallback = if (suggestedName.trim().endsWith(".json", ignoreCase = true)) "export.json" else "export.txt"
    val safeName = sanitizeExportDisplayName(suggestedName, fallback)
    return Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = exportMimeType(safeName)
        putExtra(Intent.EXTRA_TITLE, safeName)
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }
}

internal fun documentPickerFailure(code: String): JSObject = JSObject()
    .put("status", "failed").put("code", code)

internal fun takeSurrogateSafe(text: String, maxChars: Int): String {
    if (maxChars <= 0) return ""
    if (text.length <= maxChars) return text
    val cut = text.take(maxChars)
    return if (cut.isNotEmpty() && Character.isHighSurrogate(cut.last())) cut.dropLast(1) else cut
}

internal fun sanitizeDocumentDisplayName(raw: String?): String? {
    if (raw == null) return null
    val leaf = raw.substringAfterLast('/').substringAfterLast('\\')
    val cleaned = takeSurrogateSafe(leaf.filter { !Character.isISOControl(it) }.trim(), 512)
    if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") return null
    return cleaned
}

private val WINDOWS_RESERVED_STEMS = setOf(
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
)

internal fun sanitizeExportDisplayName(raw: String?, fallback: String): String {
    if (raw == null) return fallback
    val trimmedRaw = raw.trim()
    val looksLikePath = trimmedRaw.startsWith('/') ||
        trimmedRaw.startsWith('\\') ||
        trimmedRaw.split('/', '\\').any { it == "." || it == ".." }
    val source = if (looksLikePath) trimmedRaw.substringAfterLast('/').substringAfterLast('\\') else trimmedRaw
    val filtered = buildString(source.length) {
        for (ch in source) {
            if (Character.isISOControl(ch)) continue
            when (ch) {
                '/', '\\', ':', '*', '?', '"', '<', '>', '|' -> append('_')
                else -> append(ch)
            }
        }
    }.trim().trimEnd('.', ' ')
    if (filtered.isEmpty() || filtered == "." || filtered == "..") return fallback

    val lower = filtered.lowercase()
    val (rawStem, ext) = when {
        filtered.length >= ".lishi.json".length && lower.endsWith(".lishi.json") -> {
            val idx = filtered.length - ".lishi.json".length
            filtered.substring(0, idx) to filtered.substring(idx)
        }
        '.' in filtered -> {
            val dot = filtered.lastIndexOf('.')
            val candidateExt = filtered.substring(dot + 1)
            if (candidateExt.length in 1..16 && candidateExt.all { it.isLetterOrDigit() && it.code < 128 }) {
                filtered.substring(0, dot) to filtered.substring(dot)
            } else {
                filtered to ""
            }
        }
        else -> filtered to ""
    }
    val fallbackStem = fallback.substringBefore('.').ifEmpty { "export" }
    var stem = rawStem.trim().trimEnd('.', ' ')
    if (stem.isEmpty() || stem.all { it == '.' }) stem = fallbackStem
    val firstSeg = stem.substringBefore('.').trim(' ', '.').uppercase()
    if (firstSeg in WINDOWS_RESERVED_STEMS) stem = "_$stem"
    val maxChars = (180 - ext.length).coerceAtLeast(16)
    if (stem.length > maxChars) {
        val cut = takeSurrogateSafe(stem, maxChars)
        stem = cut.trimEnd('.', ' ').ifEmpty { fallbackStem }
    }
    return "$stem$ext"
}

internal fun fallbackUriDisplayName(uri: Uri): String? {
    val rawSegment = uri.lastPathSegment
        ?: uri.encodedPath?.substringAfterLast('/')?.let(Uri::decode)
        ?: return null
    var leaf = rawSegment.substringAfterLast('/').substringAfterLast('\\')
    if (':' in leaf && '/' !in rawSegment && '\\' !in rawSegment) {
        val prefix = leaf.substringBefore(':')
        val rest = leaf.substringAfter(':')
        if (prefix.isNotEmpty() && prefix.all { it.isLetterOrDigit() || it == '_' || it == '-' || it == '.' } && rest.isNotBlank()) {
            leaf = rest
        }
    }
    return sanitizeDocumentDisplayName(leaf)
}

internal fun resolveDocumentDisplayName(resolver: ContentResolver, uri: Uri): String? {
    val queried = try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }
    return sanitizeDocumentDisplayName(queried) ?: fallbackUriDisplayName(uri)
}

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
    fun isResolved() = resolved

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
    companion object {
        private val activePickCounter = AtomicInteger(0)

        internal val activePickCount: Int
            get() = activePickCounter.get()

        @JvmStatic
        internal fun isBusy(): Boolean = activePickCounter.get() > 0
    }

    private val handler = Handler(Looper.getMainLooper())
    private class Pending(
        val token: Long,
        val invoke: Invoke,
        val gate: DocumentPickerReplyGate,
        val grant: Boolean = false,
        val writable: Boolean = false,
        val directory: Boolean = false
    ) {
        var callbackReceived: Boolean = false
        var timedOut: Boolean = false
        lateinit var timeout: Runnable
        lateinit var quarantineWatch: Runnable
    }
    private val requests = DocumentPickerRequestSlot<Pending>()
    private val pending: Pending? get() = requests.current

    private fun acquireSlot(current: Pending): Boolean {
        if (!requests.acquire(current)) return false
        activePickCounter.incrementAndGet()
        return true
    }

    private fun releaseSlot(current: Pending): Boolean {
        if (!requests.release(current)) return false
        activePickCounter.updateAndGet { count -> if (count > 0) count - 1 else 0 }
        return true
    }

    private fun finish(current: Pending, value: JSObject) {
        if (pending !== current) return
        handler.removeCallbacks(current.timeout)
        handler.removeCallbacks(current.quarantineWatch)
        releaseSlot(current)
        current.gate.finish(value)
    }

    @Command
    fun ensureIdle(invoke: Invoke) {
        handler.post {
            val reply = if (pending == null && !isBusy() && !FilesPlugin.isBusy()) JSObject().put("status", "idle")
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

    @Command
    fun grantDocument(invoke: Invoke) {
        val args = invoke.getArgs()
        val directory = args.optBoolean("directory", false)
        val writable = args.optBoolean("writable", false)
        val intent = if (directory) Intent(Intent.ACTION_OPEN_DOCUMENT_TREE) else buildImportDocumentIntent()
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        if (writable) intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        launchPicker(invoke, intent, true, writable, directory)
    }

    private fun launchPicker(invoke: Invoke, intent: Intent, grant: Boolean = false, writable: Boolean = false, directory: Boolean = false) {
        handler.post {
            if (pending != null || isBusy() || FilesPlugin.isBusy()) {
                invoke.resolve(documentPickerFailure("file_busy"))
                return@post
            }
            try {
                if (ownerActivity.isFinishing || ownerActivity.isDestroyed) {
                    invoke.resolve(documentPickerFailure("file_unavailable"))
                    return@post
                }
                val token = nextPickerRequestToken.incrementAndGet()
                val current = Pending(token, invoke, DocumentPickerReplyGate { invoke.resolve(it) }, grant, writable, directory)
                current.quarantineWatch = Runnable {
                    if (pending !== current || current.token != token) return@Runnable
                    if (current.callbackReceived) {
                        releaseSlot(current)
                    } else if (!ownerActivity.isInMultiWindowMode && ownerActivity.hasWindowFocus()) {
                        scheduleReturnCheck(current, token, RETURN_CALLBACK_GRACE_MS, allowRetry = true)
                    } else if (!ownerActivity.isFinishing && !ownerActivity.isDestroyed) {
                        handler.postDelayed(current.quarantineWatch, RETURN_FOCUS_RETRY_MS)
                    } else {
                        releaseSlot(current)
                    }
                }
                current.timeout = Runnable {
                    if (pending === current && current.token == token) {
                        // Resolve the JS Invoke on timeout, but keep the slot quarantined while
                        // Picker #1 may still own Tauri's global startActivityForResultCallback.
                        current.timedOut = true
                        current.gate.timedOut()
                        if (current.callbackReceived) {
                            releaseSlot(current)
                        } else if (!ownerActivity.isInMultiWindowMode && ownerActivity.hasWindowFocus()) {
                            scheduleReturnCheck(current, token, RETURN_CALLBACK_GRACE_MS, allowRetry = true)
                        } else {
                            handler.postDelayed(current.quarantineWatch, RETURN_FOCUS_RETRY_MS)
                        }
                    }
                }
                if (!acquireSlot(current)) {
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
            current.callbackReceived = true
            handler.removeCallbacks(current.quarantineWatch)
            if (current.timedOut || current.gate.isResolved()) {
                finish(current, documentPickerFailure("file_unconfirmed"))
                return@post
            }
            val reply = try {
                val decoded = decodeDocumentPickerResult(result)
                if (!current.gate.isResolved() && decoded.optString("status") == "selected") {
                    val uri = Uri.parse(decoded.getString("uri"))
                    if (current.grant) {
                        val requestedFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or if (current.writable) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0
                        val flags = (result.data?.flags ?: 0) and requestedFlags
                        if (flags and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0) throw SecurityException("read grant missing")
                        ownerActivity.contentResolver.takePersistableUriPermission(uri, flags)
                        val document = if (current.directory) DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri)) else uri
                        val name = resolveDocumentDisplayName(ownerActivity.contentResolver, document)
                            ?: if (current.directory) "资料目录" else "资料文件"
                        decoded.put("name", name)
                        decoded.put("writable", current.writable && (flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0)
                    } else {
                        resolveDocumentDisplayName(ownerActivity.contentResolver, uri)?.let { name ->
                            decoded.put("name", name)
                        }
                    }
                }
                decoded
            }
                catch (_: Exception) { documentPickerFailure("file_unavailable") }
            finish(current, reply)
        }
    }

    override fun onPause(activity: AppCompatActivity) {
        if (activity === ownerActivity) pending?.gate?.paused()
    }

    private fun scheduleReturnCheck(current: Pending, token: Long, delayMs: Long, allowRetry: Boolean) {
        handler.postDelayed({
            if (pending !== current || current.token != token || current.callbackReceived) return@postDelayed
            if (ownerActivity.isInMultiWindowMode) {
                if (current.timedOut && !ownerActivity.isFinishing && !ownerActivity.isDestroyed) {
                    handler.postDelayed(current.quarantineWatch, RETURN_FOCUS_RETRY_MS)
                }
                return@postDelayed
            }
            if (ownerActivity.hasWindowFocus()) {
                // Normal Android activity results precede onResume. A small grace
                // also allows the already queued plugin result to run first.
                current.gate.returnedWithoutCallback()
                handler.removeCallbacks(current.timeout)
                handler.removeCallbacks(current.quarantineWatch)
                releaseSlot(current)
            } else if (allowRetry) {
                scheduleReturnCheck(current, token, RETURN_FOCUS_RETRY_MS, allowRetry = false)
            } else if (current.timedOut && !ownerActivity.isFinishing && !ownerActivity.isDestroyed) {
                handler.postDelayed(current.quarantineWatch, RETURN_FOCUS_RETRY_MS)
            }
        }, delayMs)
    }

    override fun onResume(activity: AppCompatActivity) {
        if (activity !== ownerActivity) return
        val current = pending ?: return
        if ((!current.gate.hasPaused && !current.timedOut) || current.callbackReceived) return
        if (activity.isInMultiWindowMode) return
        // `hasWindowFocus()` is always false synchronously inside `Activity.onResume()`;
        // post unconditionally and verify focus inside the delayed callback.
        scheduleReturnCheck(current, current.token, RETURN_CALLBACK_GRACE_MS, allowRetry = true)
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (activity !== ownerActivity) return
        pending?.let { finish(it, documentPickerFailure("file_unconfirmed")) }
    }
}
