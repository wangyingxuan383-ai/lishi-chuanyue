package io.timejump.chuanyue

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Base64InputStream
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

internal fun resolveBinaryExportMime(name: String, explicitMime: String?): String {
    val lower = name.trim().lowercase()
    return when {
        lower.endsWith(".epub") -> "application/epub+zip"
        lower.endsWith(".png") -> "image/png"
        lower.endsWith(".md") -> "text/markdown"
        lower.endsWith(".txt") -> "text/plain"
        !explicitMime.isNullOrBlank() && '/' in explicitMime && explicitMime.none { Character.isISOControl(it) } -> explicitMime.trim()
        lower.endsWith(".json") -> "application/json"
        else -> "application/octet-stream"
    }
}

/**
 * Native binary export plugin for Android SAF (`ACTION_CREATE_DOCUMENT`).
 * Invoked only from Rust (`files.rs`), streaming bytes into the chosen SAF `Uri`.
 */
@TauriPlugin
class FilesPlugin(private val ownerActivity: Activity) : Plugin(ownerActivity) {
    companion object {
        private val activeExportCounter = AtomicInteger(0)

        internal val activeExportCount: Int
            get() = activeExportCounter.get()

        @JvmStatic
        internal fun isBusy(): Boolean = activeExportCounter.get() > 0
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val requests = DocumentPickerRequestSlot<PendingExport>()
    private val pending: PendingExport? get() = requests.current

    private class PendingExport(
        val token: Long,
        val invoke: Invoke,
        val gate: DocumentPickerReplyGate,
        val sourcePath: String?,
        val bytesBase64: String?
    ) {
        @Volatile
        var callbackReceived: Boolean = false
        var timedOut: Boolean = false
        lateinit var timeout: Runnable
        lateinit var quarantineWatch: Runnable
    }

    private fun acquireSlot(current: PendingExport): Boolean {
        if (!requests.acquire(current)) return false
        activeExportCounter.incrementAndGet()
        return true
    }

    private fun releaseSlot(current: PendingExport) {
        if (requests.release(current)) {
            activeExportCounter.updateAndGet { count -> if (count > 0) count - 1 else 0 }
        }
    }

    private fun cleanupSource(path: String?) {
        if (path.isNullOrBlank()) return
        try {
            val exportDir = File(ownerActivity.cacheDir, "export-bytes").canonicalFile
            val candidate = File(path).canonicalFile
            if (candidate.parentFile == exportDir && candidate.isFile) {
                candidate.delete()
            }
        } catch (_: Throwable) {
            // Best-effort cleanup; Rust RAII guard also deletes its temporary file.
        }
    }

    private fun finish(current: PendingExport, value: JSObject) {
        if (pending !== current) return
        mainHandler.removeCallbacks(current.timeout)
        mainHandler.removeCallbacks(current.quarantineWatch)
        releaseSlot(current)
        current.gate.finish(value)
    }

    @Command
    fun exportBytes(invoke: Invoke) {
        val args = invoke.getArgs()
        val rawName = args.optString("defaultName", "export.bin")
        val explicitMime = args.optString("mime", "").takeIf { it.isNotBlank() }
        val sourcePath = args.optString("sourcePath", "").takeIf { it.isNotBlank() }
        val bytesBase64 = args.optString("bytesBase64", "").takeIf { it.isNotEmpty() }

        val safeName = sanitizeExportDisplayName(rawName, "export.bin")
        val resolvedMime = resolveBinaryExportMime(safeName, explicitMime)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = resolvedMime
            putExtra(Intent.EXTRA_TITLE, safeName)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }

        mainHandler.post {
            if (pending != null || isBusy() || DocumentPickerPlugin.isBusy()) {
                cleanupSource(sourcePath)
                invoke.resolve(documentPickerFailure("file_busy"))
                return@post
            }
            if (ownerActivity.isFinishing || ownerActivity.isDestroyed) {
                cleanupSource(sourcePath)
                invoke.resolve(documentPickerFailure("file_unavailable"))
                return@post
            }
            val token = nextPickerRequestToken.incrementAndGet()
            val current = PendingExport(token, invoke, DocumentPickerReplyGate { invoke.resolve(it) }, sourcePath, bytesBase64)
            current.quarantineWatch = Runnable {
                if (pending !== current || current.token != token) return@Runnable
                if (current.callbackReceived) {
                    return@Runnable
                } else if (!ownerActivity.isInMultiWindowMode && ownerActivity.hasWindowFocus()) {
                    scheduleReturnCheck(current, token, RETURN_CALLBACK_GRACE_MS, allowRetry = true)
                } else if (!ownerActivity.isFinishing && !ownerActivity.isDestroyed) {
                    mainHandler.postDelayed(current.quarantineWatch, RETURN_FOCUS_RETRY_MS)
                } else {
                    cleanupSource(current.sourcePath)
                    releaseSlot(current)
                }
            }
            current.timeout = Runnable {
                if (pending === current && current.token == token) {
                    // Resolve the JS Invoke on timeout, while keeping the slot quarantined
                    // until the SAF picker closes via ActivityResult or focused return.
                    current.timedOut = true
                    if (!current.callbackReceived) {
                        cleanupSource(current.sourcePath)
                    }
                    current.gate.timedOut()
                    if (!current.callbackReceived) {
                        if (!ownerActivity.isInMultiWindowMode && ownerActivity.hasWindowFocus()) {
                            scheduleReturnCheck(current, token, RETURN_CALLBACK_GRACE_MS, allowRetry = true)
                        } else {
                            mainHandler.postDelayed(current.quarantineWatch, RETURN_FOCUS_RETRY_MS)
                        }
                    }
                }
            }
            if (!acquireSlot(current)) {
                cleanupSource(sourcePath)
                invoke.resolve(documentPickerFailure("file_busy"))
                return@post
            }
            if (!mainHandler.postDelayed(current.timeout, DOCUMENT_PICK_TIMEOUT_MS)) {
                cleanupSource(sourcePath)
                finish(current, documentPickerFailure("file_unavailable"))
                return@post
            }
            try {
                startActivityForResult(invoke, intent, "exportBytesResult")
            } catch (_: Throwable) {
                cleanupSource(sourcePath)
                finish(current, documentPickerFailure("file_unavailable"))
            }
        }
    }

    @ActivityCallback
    fun exportBytesResult(invoke: Invoke, result: ActivityResult) {
        mainHandler.post {
            val current = pending ?: return@post
            if (current.invoke !== invoke) return@post
            val expectedToken = current.token
            current.callbackReceived = true
            mainHandler.removeCallbacks(current.quarantineWatch)
            if (current.timedOut || current.gate.isResolved()) {
                cleanupSource(current.sourcePath)
                finish(current, documentPickerFailure("file_unconfirmed"))
                return@post
            }
            val decoded = try {
                decodeDocumentPickerResult(result)
            } catch (_: Throwable) {
                documentPickerFailure("file_unavailable")
            }
            val status = decoded.optString("status")
            if (status != "selected") {
                cleanupSource(current.sourcePath)
                finish(current, decoded)
                return@post
            }
            val uriText = decoded.optString("uri")
            ioExecutor.execute {
                val reply = try {
                    val uri = Uri.parse(uriText)
                    if (uri.scheme != "content" || uri.authority.isNullOrEmpty()) {
                        throw SecurityException("invalid saf uri")
                    }
                    val out = (try {
                        ownerActivity.contentResolver.openOutputStream(uri, "wt")
                    } catch (_: Throwable) {
                        ownerActivity.contentResolver.openOutputStream(uri)
                    }) ?: throw IllegalStateException("output stream unavailable")

                    out.use { stream ->
                        val buffer = ByteArray(65536)
                        if (!current.sourcePath.isNullOrBlank()) {
                            val exportDir = File(ownerActivity.cacheDir, "export-bytes").canonicalFile
                            val sourceFile = File(current.sourcePath).canonicalFile
                            if (sourceFile.parentFile != exportDir || !sourceFile.isFile) {
                                throw SecurityException("unexpected source path")
                            }
                            FileInputStream(sourceFile).use { input ->
                                while (true) {
                                    val count = input.read(buffer)
                                    if (count <= 0) break
                                    stream.write(buffer, 0, count)
                                }
                            }
                        } else if (!current.bytesBase64.isNullOrEmpty()) {
                            val rawBytes = current.bytesBase64.toByteArray(Charsets.US_ASCII)
                            Base64InputStream(ByteArrayInputStream(rawBytes), Base64.DEFAULT).use { input ->
                                while (true) {
                                    val count = input.read(buffer)
                                    if (count <= 0) break
                                    stream.write(buffer, 0, count)
                                }
                            }
                        }
                        stream.flush()
                    }
                    JSObject().put("status", "saved")
                } catch (_: Throwable) {
                    documentPickerFailure("file_write_failed")
                } finally {
                    cleanupSource(current.sourcePath)
                }
                mainHandler.post {
                    if (pending === current && current.token == expectedToken) {
                        finish(current, reply)
                    }
                }
            }
        }
    }

    override fun onPause(activity: AppCompatActivity) {
        if (activity === ownerActivity) pending?.gate?.paused()
    }

    private fun scheduleReturnCheck(current: PendingExport, token: Long, delayMs: Long, allowRetry: Boolean) {
        mainHandler.postDelayed({
            if (pending !== current || current.token != token || current.callbackReceived) return@postDelayed
            if (ownerActivity.isInMultiWindowMode) {
                if (current.timedOut && !ownerActivity.isFinishing && !ownerActivity.isDestroyed) {
                    mainHandler.postDelayed(current.quarantineWatch, RETURN_FOCUS_RETRY_MS)
                }
                return@postDelayed
            }
            if (ownerActivity.hasWindowFocus()) {
                cleanupSource(current.sourcePath)
                current.gate.returnedWithoutCallback()
                mainHandler.removeCallbacks(current.timeout)
                mainHandler.removeCallbacks(current.quarantineWatch)
                releaseSlot(current)
            } else if (allowRetry) {
                scheduleReturnCheck(current, token, RETURN_FOCUS_RETRY_MS, allowRetry = false)
            } else if (current.timedOut && !ownerActivity.isFinishing && !ownerActivity.isDestroyed) {
                mainHandler.postDelayed(current.quarantineWatch, RETURN_FOCUS_RETRY_MS)
            }
        }, delayMs)
    }

    override fun onResume(activity: AppCompatActivity) {
        if (activity !== ownerActivity) return
        val current = pending ?: return
        if ((!current.gate.hasPaused && !current.timedOut) || current.callbackReceived) return
        if (activity.isInMultiWindowMode) return
        // `hasWindowFocus()` is always false synchronously inside `Activity.onResume()`;
        // check focus inside the delayed callback and retry once if focus transition is still settling.
        scheduleReturnCheck(current, current.token, RETURN_CALLBACK_GRACE_MS, allowRetry = true)
    }

    override fun onDestroy(activity: AppCompatActivity) {
        if (activity !== ownerActivity) return
        pending?.let {
            cleanupSource(it.sourcePath)
            finish(it, documentPickerFailure("file_unconfirmed"))
        }
        ioExecutor.shutdown()
    }
}
