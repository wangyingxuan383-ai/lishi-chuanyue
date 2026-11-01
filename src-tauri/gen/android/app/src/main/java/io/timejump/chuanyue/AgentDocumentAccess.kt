package io.timejump.chuanyue

import android.content.Context
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.annotation.Keep
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** Called only by the native service with a database-checked grant. */
@Keep
object AgentDocumentAccess {
    private class Operation { val cancelled = AtomicBoolean(false); val signal = CancellationSignal() }
    private class Failure(message: String) : Exception(message)
    private val operations = ConcurrentHashMap<String, Operation>()
    private const val MAX_BYTES = 64L * 1024 * 1024
    private fun check(operation: Operation) { if (operation.cancelled.get()) throw Failure("资料操作已停止。") }
    @JvmStatic fun cancel(id: String) {
        if (operations.size > 256) operations.entries.removeIf { it.value.cancelled.get() }
        val operation = operations.computeIfAbsent(id) { Operation() }
        operation.cancelled.set(true); operation.signal.cancel()
    }
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun query(context: Context, uri: Uri): Pair<String, Boolean> = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) throw Failure("资料已删除或无权访问。")
        Pair(cursor.getString(0) ?: "资料.txt", cursor.getString(1) == DocumentsContract.Document.MIME_TYPE_DIR)
    } ?: throw Failure("无法取得资料信息。")
    private fun selected(context: Context, scope: JSONObject, path: String, writing: Boolean, onCreate: () -> Unit): Uri {
        val root = Uri.parse(scope.optString("uri"))
        if (root.scheme != "content" || root.authority.isNullOrEmpty()) throw Failure("资料授权无效。")
        if (path.startsWith('/') || path.contains('\\') || path.contains(':') || path.contains('\u0000') || path.split('/').any { it == "." || it == ".." }) throw Failure("资料路径越出授权范围。")
        if (!scope.optBoolean("directory")) { if (path.isNotEmpty()) throw Failure("单文件授权不能访问其他资料。"); return root }
        var document = DocumentsContract.buildDocumentUriUsingTree(root, DocumentsContract.getTreeDocumentId(root))
        val parts = path.split('/').filter { it.isNotEmpty() }
        for ((index, name) in parts.withIndex()) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(root, DocumentsContract.getDocumentId(document))
            val matches = ArrayList<Uri>()
            context.contentResolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) if (cursor.getString(1) == name) matches.add(DocumentsContract.buildDocumentUriUsingTree(root, cursor.getString(0)))
            }
            if (matches.size > 1) throw Failure("目录有同名资料，无法安全确定目标。")
            if (matches.isEmpty()) {
                if (writing && index == parts.lastIndex) {
                    val created = DocumentsContract.createDocument(context.contentResolver, document, "text/plain", name) ?: throw Failure("无法建立目标笔记。")
                    onCreate(); return created
                }
                throw Failure("资料不存在，请重新查看目录。")
            }
            document = matches.single()
        }
        return document
    }
    private fun digest(context: Context, uri: Uri, operation: Operation): String {
        val digest = MessageDigest.getInstance("SHA-256"); var total = 0L
        val descriptor = context.contentResolver.openFileDescriptor(uri, "r", operation.signal) ?: throw Failure("无法读取资料。")
        ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { stream ->
            val buffer = ByteArray(65536)
            while (true) { check(operation); val count = stream.read(buffer); if (count < 0) break; total += count; if (total > MAX_BYTES) throw Failure("资料超过64MiB。"); digest.update(buffer, 0, count) }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    @JvmStatic fun execute(context: Context, payload: String): String {
        var id = ""; var writeStarted = false; var newlyCreated = false; var temporary: File? = null
        try {
            val request = JSONObject(payload); id = request.getString("operationId")
            val operation = operations.computeIfAbsent(id) { Operation() }; check(operation)
            val op = request.getString("op"); val writing = op == "write_document"
            val scope = request.getJSONObject("_documentGrant")
            if (writing) {
                val selectedName = request.optString("path", "").ifEmpty { scope.optString("name") }
                if (selectedName.substringAfterLast('.', "").lowercase() !in setOf("txt", "md", "json")) throw Failure("外部写入仅支持UTF-8笔记。")
                if (request.getString("text").toByteArray(Charsets.UTF_8).size > 256 * 1024) throw Failure("单次笔记最多256KiB。")
            }
            val uri = selected(context, scope, request.optString("path", ""), writing) { newlyCreated = true }
            val (name, directory) = query(context, uri)
            if (op == "list_documents") {
                val entries = ArrayList<JSONObject>()
                if (!directory) entries.add(JSONObject().put("name", name).put("path", "").put("directory", false))
                else {
                    val children = DocumentsContract.buildChildDocumentsUriUsingTree(uri, DocumentsContract.getDocumentId(uri))
                    context.contentResolver.query(children, arrayOf(OpenableColumns.DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE), null, null, null)?.use { cursor ->
                        while (cursor.moveToNext()) { check(operation); if (entries.size >= 10000) throw Failure("目录超过一万项，请选择更具体的目录。")
                            val child = cursor.getString(0) ?: continue; val prefix = request.optString("path", "")
                            entries.add(JSONObject().put("name", child).put("path", if (prefix.isEmpty()) child else "$prefix/$child").put("directory", cursor.getString(1) == DocumentsContract.Document.MIME_TYPE_DIR).put("bytes", cursor.getLong(2)))
                        }
                    }
                }
                entries.sortBy { it.optString("name") }; val version = sha(JSONArray(entries).toString().toByteArray())
                if (request.has("version") && request.optString("version") != version) throw Failure("资料目录已变化，请从头重新读取。")
                val offset = request.optInt("offset", 0).coerceAtLeast(0); val size = request.optInt("pageSize", 40).coerceIn(1, 100); val next = (offset + size).coerceAtMost(entries.size)
                return JSONObject().put("entries", JSONArray(entries.drop(offset).take(size))).put("version", version).put("total", entries.size).put("offset", offset).put("nextOffset", next).put("complete", next >= entries.size).toString()
            }
            if (directory) throw Failure("请选择目录中的具体资料。")
            val extension = name.substringAfterLast('.', "").lowercase()
            if (extension !in setOf("txt", "md", "json", "epub", "pdf", "docx")) throw Failure("仅支持TXT、MD、JSON、EPUB、PDF和DOCX资料。")
            if (writing) {
                if (extension !in setOf("txt", "md", "json")) throw Failure("外部写入仅支持UTF-8笔记。")
                val bytes = request.getString("text").toByteArray(Charsets.UTF_8); if (bytes.size > 256 * 1024) throw Failure("单次笔记最多256KiB。")
                val before = digest(context, uri, operation)
                if (!newlyCreated && request.optString("version") != before) throw Failure("资料版本已变化或缺少读取版本，未覆盖原文件。")
                check(operation); writeStarted = true
                val descriptor = context.contentResolver.openFileDescriptor(uri, "rwt", operation.signal) ?: throw Failure("无法写入资料。")
                ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { stream ->
                    var offset = 0; while (offset < bytes.size) { check(operation); val end = (offset + 65536).coerceAtMost(bytes.size); stream.write(bytes, offset, end - offset); offset = end }; stream.flush()
                }
                val version = digest(context, uri, operation); if (version != sha(bytes)) throw Failure("写入后读回不一致，请先核对文件。")
                return JSONObject().put("written", true).put("version", version).put("bytes", bytes.size).put("storyUndoApplies", false).toString()
            }
            val task = request.getString("taskId"); if (!task.matches(Regex("[A-Za-z0-9-]{1,128}"))) throw Failure("资料请求不属于有效任务。")
            val folder = File(context.applicationInfo.dataDir, "agent-documents/$task"); if (!folder.isDirectory && !folder.mkdirs()) throw Failure("资料缓存不可用。")
            val scratch = File(folder, UUID.randomUUID().toString() + ".tmp"); temporary = scratch
            val digest = MessageDigest.getInstance("SHA-256"); var total = 0L
            val descriptor = context.contentResolver.openFileDescriptor(uri, "r", operation.signal) ?: throw Failure("资料授权已失效。")
            ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input -> scratch.outputStream().use { output ->
                val buffer = ByteArray(65536)
                while (true) { check(operation); val count = input.read(buffer); if (count < 0) break; total += count; if (total > MAX_BYTES) throw Failure("资料超过64MiB。"); digest.update(buffer, 0, count); output.write(buffer, 0, count) }
            } }
            val version = digest.digest().joinToString("") { "%02x".format(it) }
            if (request.has("version") && request.optString("version") != version) throw Failure("资料已变化，请重新读取并核对位置。")
            val target = File(folder, "$version.bin"); if (target.exists()) scratch.delete() else if (!scratch.renameTo(target)) throw Failure("资料缓存未能保存。")
            return JSONObject().put("_documentRead", JSONObject().put("path", target.absolutePath).put("name", name).put("version", version)).toString()
        } catch (error: Exception) {
            val message = if (error is Failure) error.message else if (error is SecurityException) "资料授权已失效，请重新选择。" else "资料操作未完成，请核对文件状态。"
            val unknown = writeStarted || newlyCreated
            return JSONObject().put("isError", true).put("outcomeUnknown", unknown).put("error", JSONObject().put("code", if (unknown) "file_write_unconfirmed" else "file_unavailable").put("message", message)).toString()
        } finally { temporary?.delete(); if (id.isNotEmpty()) operations.remove(id) }
    }
}
