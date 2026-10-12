package io.timejump.lishi

import android.content.Context
import android.net.Uri

/** Unannotated, Rust-only JNI entry. Called on a Rust blocking worker. */
object RustFileAccessBridge {
    @JvmStatic
    fun openFdForRust(context: Context, uriText: String, mode: String): Int {
        if (uriText.length > 8192 || (mode != "r" && mode != "wt")) return -1
        return try {
            val uri = Uri.parse(uriText)
            if (uri.scheme != "content") return -1
            // openFileDescriptor represents the whole document, unlike an
            // AssetFileDescriptor whose offset/declared length must be handled.
            context.contentResolver.openFileDescriptor(uri, mode)?.use { descriptor ->
                descriptor.detachFd()
            } ?: -1
        } catch (_: Exception) {
            // No raw URI, provider exception, path or request body is logged.
            -1
        }
    }
}
