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
    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val requests = DocumentPickerRequestSlot<PendingExport>()
    private val pending: PendingExport? get() = requests.current

    private class PendingExport(
        val invoke: Invoke,
        val gate: DocumentPickerReplyGate,
        val sourcePath: String?,
        val bytesBase64: String?
    ) {
        lateinit var timeout: Runnable
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
        requests.release(current)
        current.gate.finish(value)
    }

    @Command
    fun exportBytes(invoke: Invoke) {
        val args = invoke.getArgs()
        val rawName = args.optString("defaultName", "export.bin")
        val explicitMime = args.optString("mime", "").takeIf { it.isNotBlank() }
        val sourcePath = args.optString("sourcePath", "").takeIf { it.isNotBlank() }
        val bytesBase64 = args.optString("bytesBase64", "").takeIf { it.isNotEmpty() }

        val safeName = sanitizeDocumentDisplayName(rawName) ?: "export.bin"
        val resolvedMime = resolveBinaryExportMime(safeName, explicitMime)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = resolvedMime
            putExtra(Intent.EXTRA_TITLE, safeName)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }

        mainHandler.post {
            if (pending != null) {
                cleanupSource(sourcePath)
                invoke.resolve(documentPickerFailure("file_busy"))
                return@post
            }
            if (ownerActivity.isFinishing || ownerActivity.isDestroyed) {
                cleanupSource(sourcePath)
                invoke.resolve(documentPickerFailure("file_unavailable"))
                return@post
            }
            val current = PendingExport(invoke, DocumentPickerReplyGate { invoke.resolve(it) }, sourcePath, bytesBase64)
            current.timeout = Runnable {
                if (pending === current) {
                    cleanupSource(current.sourcePath)
                    current.gate.timedOut()
                }
            }
            if (!requests.acquire(current)) {
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
                mainHandler.post { finish(current, reply) }
            }
        }
    }

    override fun onPause(activity: AppCompatActivity) {
        if (activity === ownerActivity) pending?.gate?.paused()
    }

    override fun onResume(activity: AppCompatActivity) {
        if (activity !== ownerActivity) return
        val current = pending ?: return
        if (!current.gate.hasPaused) return
        mainHandler.postDelayed({
            if (pending === current) {
                cleanupSource(current.sourcePath)
                current.gate.returnedWithoutCallback()
                mainHandler.removeCallbacks(current.timeout)
                requests.release(current)
            }
        }, 1_000L)
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
