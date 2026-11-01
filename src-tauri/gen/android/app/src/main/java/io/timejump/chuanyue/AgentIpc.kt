package io.timejump.chuanyue

import android.content.Context
import android.os.Bundle
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID

/** Binder carries small envelopes; larger JSON stays in the app's private cache. */
internal object AgentIpc {
    const val COMMAND = 4101
    const val REPLY = 4102
    const val MAX_BYTES = 8 * 1024 * 1024
    private const val INLINE_BYTES = 48 * 1024
    private fun directory(context: Context): File = File(context.cacheDir, "agent-ipc").also {
        check(it.mkdirs() || it.isDirectory)
    }.canonicalFile
    fun put(context: Context, bundle: Bundle, json: String) {
        val bytes = json.toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_BYTES) { "助手消息过长，请分页读取" }
        if (bytes.size <= INLINE_BYTES) { bundle.putString("json", json); return }
        val file = File(directory(context), "ipc-${UUID.randomUUID()}.json")
        try {
            FileOutputStream(file).use { it.write(bytes); it.fd.sync() }
            bundle.putString("file", file.name)
            bundle.putInt("bytes", bytes.size)
        } catch (error: Exception) { file.delete(); throw error }
    }
    fun read(context: Context, bundle: Bundle): String {
        bundle.getString("json")?.let {
            require(it.toByteArray(Charsets.UTF_8).size <= INLINE_BYTES)
            return it
        }
        val name = bundle.getString("file") ?: error("助手消息不完整")
        require(Regex("ipc-[a-f0-9-]+\\.json").matches(name))
        val root = directory(context)
        val file = File(root, name).canonicalFile
        require(file.parentFile == root && file.isFile && file.length() in 1..MAX_BYTES.toLong())
        require(bundle.getInt("bytes") == file.length().toInt())
        try {
            val bytes = ByteArrayOutputStream()
            FileInputStream(file).use { input ->
                val buffer = ByteArray(16384)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    require(bytes.size() + count <= MAX_BYTES)
                    bytes.write(buffer, 0, count)
                }
            }
            return bytes.toString("UTF-8")
        } finally { file.delete() }
    }
    fun discard(context: Context, bundle: Bundle) {
        val name = bundle.getString("file") ?: return
        if (Regex("ipc-[a-f0-9-]+\\.json").matches(name)) File(directory(context), name).delete()
    }
}
